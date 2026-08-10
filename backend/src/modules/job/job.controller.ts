import { Response } from 'express';
import { JobStatus } from '@prisma/client';
import { InvalidInputError, NotFoundError } from '../../errors';
import { AuthenticatedRequest } from '../../types/authenticatedRequest';
import { JobService } from './job.service';
import { JobSseEventType, PublicJob } from './job.types';
import { jobNotificationListener } from './job.notifications';

const JOB_SSE_POLL_INTERVAL_MS = 1000;
const JOB_SSE_HEARTBEAT_INTERVAL_MS = 15000;

function parseJobId(value: string): number {
  const id = parseInt(value, 10);
  if (isNaN(id)) {
    throw new InvalidInputError(`The ID parameter '${value}' is not a valid number.`);
  }
  return id;
}

function getWorkspaceId(req: AuthenticatedRequest): number {
  const workspaceId = req.workspace?.id;
  if (!workspaceId) {
    throw new InvalidInputError('Workspace context is required');
  }
  return workspaceId;
}

function writeSseEvent(res: Response, event: JobSseEventType, data: PublicJob): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function getTerminalEvent(status: JobStatus): JobSseEventType | null {
  if (status === JobStatus.SUCCEEDED) return 'succeeded';
  if (status === JobStatus.FAILED) return 'failed';
  if (status === JobStatus.CANCELLED) return 'cancelled';
  return null;
}

function waitForNotificationOrTimeout(
  ms: number,
  consumePendingNotification: () => boolean,
  registerWake: (wake: (() => void) | null) => void,
): Promise<'notification' | 'timeout'> {
  if (consumePendingNotification()) {
    return Promise.resolve('notification');
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      registerWake(null);
      resolve('timeout');
    }, ms);

    registerWake(() => {
      clearTimeout(timeout);
      registerWake(null);
      resolve('notification');
    });
  });
}

export const JobController = {
  async getJob(req: AuthenticatedRequest, res: Response): Promise<void> {
    const jobId = parseJobId(req.params.jobId);
    const job = await JobService.getJobInWorkspace(jobId, getWorkspaceId(req));
    res.status(200).json({ data: job });
  },

  async cancelJob(req: AuthenticatedRequest, res: Response): Promise<void> {
    const jobId = parseJobId(req.params.jobId);
    const job = await JobService.requestCancellationInWorkspace(jobId, getWorkspaceId(req));
    res.status(200).json({ data: job });
  },

  async streamJob(req: AuthenticatedRequest, res: Response): Promise<void> {
    const jobId = parseJobId(req.params.jobId);
    const workspaceId = getWorkspaceId(req);

    let job = await JobService.getJobInWorkspace(jobId, workspaceId);
    let clientClosed = false;
    let lastSerializedJob = JSON.stringify(job);
    let lastEventAt = Date.now();
    let pendingNotification = false;
    let notificationWake: (() => void) | null = null;
    const unsubscribe = jobNotificationListener.subscribe(jobId, () => {
      if (notificationWake) {
        notificationWake();
        return;
      }
      pendingNotification = true;
    });

    req.on?.('aborted', () => {
      clientClosed = true;
      unsubscribe();
    });
    res.on?.('close', () => {
      clientClosed = true;
      unsubscribe();
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      writeSseEvent(res, 'snapshot', job);
      lastEventAt = Date.now();

      const initialTerminalEvent = getTerminalEvent(job.status);
      if (initialTerminalEvent) {
        writeSseEvent(res, initialTerminalEvent, job);
        return;
      }

      while (!clientClosed && !res.writableEnded) {
        await waitForNotificationOrTimeout(
          JOB_SSE_POLL_INTERVAL_MS,
          () => {
            if (!pendingNotification) return false;
            pendingNotification = false;
            return true;
          },
          (wake) => {
            notificationWake = wake;
          },
        );
        if (clientClosed || res.writableEnded) break;

        try {
          job = await JobService.getJobInWorkspace(jobId, workspaceId);
        } catch (error: unknown) {
          if (error instanceof NotFoundError) break;
          throw error;
        }
        const serializedJob = JSON.stringify(job);
        const terminalEvent = getTerminalEvent(job.status);

        if (terminalEvent) {
          writeSseEvent(res, terminalEvent, job);
          break;
        }

        if (serializedJob !== lastSerializedJob) {
          writeSseEvent(res, 'progress', job);
          lastSerializedJob = serializedJob;
          lastEventAt = Date.now();
          continue;
        }

        if (Date.now() - lastEventAt >= JOB_SSE_HEARTBEAT_INTERVAL_MS) {
          writeSseEvent(res, 'heartbeat', job);
          lastEventAt = Date.now();
        }
      }
    } finally {
      unsubscribe();
      if (!res.writableEnded) {
        res.end();
      }
    }
  },
};
