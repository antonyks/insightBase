import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { Prisma } from '@prisma/client';
import { JobStatus } from '@prisma/client';
import { logger } from '../../config/logger';
import { InvalidInputError } from '../../errors';
import { SelectedJob } from './job.model';
import { JobService } from './job.service';
import { JobQueuePayload } from './job.types';

export const DEFAULT_WORKER_JOB_HEARTBEAT_INTERVAL_MS = 10_000;

export class JobWorkerCancelledError extends Error {
  constructor(jobId: number) {
    super(`Job ${jobId} was cancelled.`);
    this.name = 'JobWorkerCancelledError';
  }
}

export class JobWorkerShutdownError extends Error {
  constructor(jobId: number) {
    super(`Job ${jobId} was interrupted by worker shutdown.`);
    this.name = 'JobWorkerShutdownError';
  }
}

export interface JobWorkerContext {
  job: SelectedJob;
  payload: Prisma.JsonValue | null;
  signal: AbortSignal;
  heartbeat: () => Promise<void>;
  checkpointCancellation: () => Promise<void>;
}

export type JobWorkerHandler = (
  context: JobWorkerContext,
) => Promise<Prisma.InputJsonValue | undefined | void>;

export interface JobWorkerRunnerOptions {
  heartbeatIntervalMs?: number;
  touchJob?: (queueName: string, queueMessageId: string) => Promise<void>;
}

export interface CreateJobWorkerHandlerOptions extends JobWorkerRunnerOptions {
  boss?: Pick<PgBoss, 'touch'>;
}

export function createJobWorkerHandler(
  handler: JobWorkerHandler,
  options: CreateJobWorkerHandlerOptions = {},
) {
  const touchJob = options.touchJob ?? createPgBossTouchJob(options.boss);

  return async (jobs: JobWithMetadata<JobQueuePayload>[]): Promise<void> => {
    for (const job of jobs) {
      await runJobWorker(job, handler, {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        touchJob,
      });
    }
  };
}

export async function runJobWorker(
  queueJob: JobWithMetadata<JobQueuePayload>,
  handler: JobWorkerHandler,
  options: JobWorkerRunnerOptions = {},
): Promise<void> {
  const jobId = parseQueueJobId(queueJob.data);
  let appJob: SelectedJob | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const heartbeat = async (): Promise<void> => {
    if (queueJob.signal.aborted) {
      throw new JobWorkerShutdownError(jobId);
    }

    await JobService.heartbeat(jobId);
    await options.touchJob?.(queueJob.name, queueJob.id);
  };

  const checkpointCancellation = async (): Promise<void> => {
    const currentJob = await JobService.checkpointCancellation(jobId);
    if (currentJob.status === JobStatus.CANCELLED) {
      throw new JobWorkerCancelledError(jobId);
    }
  };

  try {
    await checkpointCancellation();
    appJob = await JobService.startWorkerAttempt(jobId);

    if (appJob.status === JobStatus.CANCELLED) {
      return;
    }

    if (isTerminalWorkerState(appJob.status)) {
      return;
    }

    await checkpointCancellation();
    heartbeatTimer = startHeartbeatLoop(
      options.heartbeatIntervalMs ?? DEFAULT_WORKER_JOB_HEARTBEAT_INTERVAL_MS,
      heartbeat,
      jobId,
    );

    const result = await handler({
      job: appJob,
      payload: appJob.payload,
      signal: queueJob.signal,
      heartbeat,
      checkpointCancellation,
    });

    if (queueJob.signal.aborted) {
      throw new JobWorkerShutdownError(jobId);
    }

    await checkpointCancellation();
    const persistedResult: Prisma.InputJsonValue | undefined =
      result === undefined ? undefined : result;
    await JobService.markSucceeded(jobId, persistedResult);
  } catch (error: unknown) {
    if (error instanceof JobWorkerCancelledError) {
      return;
    }

    if (queueJob.signal.aborted || error instanceof JobWorkerShutdownError) {
      throw error;
    }

    const cancellationState = await JobService.checkpointCancellation(jobId);
    if (cancellationState.status === JobStatus.CANCELLED) {
      return;
    }

    if (isFinalAttempt(appJob, queueJob)) {
      await JobService.markHandlerFailed(jobId);
    } else {
      await JobService.markRetryPending(jobId);
    }

    throw error;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

function createPgBossTouchJob(
  boss: Pick<PgBoss, 'touch'> | undefined,
): JobWorkerRunnerOptions['touchJob'] {
  if (!boss) return undefined;

  return async (queueName: string, queueMessageId: string): Promise<void> => {
    await boss.touch(queueName, queueMessageId);
  };
}

function parseQueueJobId(payload: JobQueuePayload): number {
  const jobId = payload?.jobId;
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new InvalidInputError('Worker queue payload must include a valid jobId.', 'JOB_QUEUE_PAYLOAD_INVALID');
  }
  return jobId;
}

function isFinalAttempt(
  appJob: SelectedJob | null,
  queueJob: JobWithMetadata<JobQueuePayload>,
): boolean {
  if (appJob) {
    return appJob.attempts >= appJob.maxAttempts;
  }

  return queueJob.retryCount >= queueJob.retryLimit;
}

function isTerminalWorkerState(status: JobStatus): boolean {
  return status === JobStatus.SUCCEEDED ||
    status === JobStatus.FAILED ||
    status === JobStatus.CANCELLED;
}

function startHeartbeatLoop(
  heartbeatIntervalMs: number,
  heartbeat: () => Promise<void>,
  jobId: number,
): NodeJS.Timeout {
  return setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      logger.warn(
        {
          err: error,
          jobId,
          operation: 'job.worker.heartbeat',
        },
        'Job worker heartbeat failed.',
      );
    });
  }, heartbeatIntervalMs);
}
