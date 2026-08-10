import { Prisma, JobStatus } from '@prisma/client';
import { InvalidInputError, NotFoundError } from '../../errors';
import {
  assertValidJobProgress,
  assertValidJobStatusTransition,
  isTerminalJobStatus,
} from './jobLifecycle';
import { JobRepository } from './job.repository';
import { SelectedJob } from './job.model';
import { assertJobDataIsSanitized } from './jobPrivacy';
import {
  EnqueueJobInput,
  JobQueueTransport,
  JobReconciliationResult,
  PublicJob,
} from './job.types';

const ENQUEUE_FAILED_ERROR_CODE = 'JOB_QUEUE_ENQUEUE_FAILED';
const ENQUEUE_FAILED_ERROR_MESSAGE = 'Job queue enqueue failed.';
const DEFAULT_RECONCILIATION_LIMIT = 100;

export const JobService = {
  async getJobInWorkspace(jobId: number, workspaceId: number): Promise<PublicJob> {
    return toPublicJob(await getExistingJobInWorkspace(jobId, workspaceId));
  },

  async enqueueJob(
    input: EnqueueJobInput,
    queueTransport: JobQueueTransport,
  ): Promise<SelectedJob> {
    const payload = input.payload ?? {};
    assertJobDataIsSanitized(payload);

    const job = await JobRepository.createQueuedJob({
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      type: input.type,
      payload,
      maxAttempts: input.maxAttempts ?? 1,
      stage: input.stage ?? 'queued',
    });

    let queueMessageId: string | null;
    try {
      queueMessageId = await queueTransport.send(input.queueName ?? input.type, {
        jobId: job.id,
      });

      if (!queueMessageId) {
        throw new Error('pg-boss did not return a message identifier.');
      }
    } catch {
      return markEnqueueFailed(job.id);
    }

    return JobRepository.updateJob(job.id, {
      queueMessageId,
    });
  },

  async reconcileQueuedJobsWithoutQueueMessage(
    queueTransport: JobQueueTransport,
    options: { limit?: number } = {},
  ): Promise<JobReconciliationResult> {
    return JobRepository.runWithJobQueueReconciliationLock(async (lockAcquired, db) => {
      if (!lockAcquired) {
        return {
          skipped: true,
          scanned: 0,
          reenqueued: 0,
          failed: 0,
        };
      }

      const queuedJobs = await JobRepository.findQueuedJobsWithoutQueueMessage(
        options.limit ?? DEFAULT_RECONCILIATION_LIMIT,
        db,
      );
      const result: JobReconciliationResult = {
        skipped: false,
        scanned: queuedJobs.length,
        reenqueued: 0,
        failed: 0,
      };

      for (const job of queuedJobs) {
        let queueMessageId: string | null;
        try {
          queueMessageId = await queueTransport.send(job.type, { jobId: job.id });

          if (!queueMessageId) {
            throw new Error('pg-boss did not return a message identifier.');
          }
        } catch {
          await markEnqueueFailed(job.id, db);
          result.failed += 1;
          continue;
        }

        await JobRepository.updateJob(job.id, {
          queueMessageId,
        }, db);
        result.reenqueued += 1;
      }

      return result;
    });
  },

  async markRunning(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.RUNNING) return job;

    assertValidJobStatusTransition(job.status, JobStatus.RUNNING);
    return JobRepository.updateJob(job.id, {
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? new Date(),
      heartbeatAt: new Date(),
    });
  },

  async updateProgress(
    jobId: number,
    progress: number,
    stage?: string,
  ): Promise<SelectedJob> {
    assertValidJobProgress(progress);

    const job = await getExistingJob(jobId);
    if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.CANCEL_REQUESTED) {
      throw new InvalidInputError(
        'Job progress can only be updated while running or cancellation is requested.',
        'JOB_PROGRESS_STATUS_INVALID',
      );
    }

    return JobRepository.updateJob(job.id, {
      progress,
      ...(stage ? { stage } : {}),
    });
  },

  async requestCancellation(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.CANCEL_REQUESTED || isTerminalJobStatus(job.status)) {
      return job;
    }

    assertValidJobStatusTransition(job.status, JobStatus.CANCEL_REQUESTED);
    return JobRepository.updateJob(job.id, {
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
    });
  },

  async requestCancellationInWorkspace(
    jobId: number,
    workspaceId: number,
  ): Promise<PublicJob> {
    const job = await getExistingJobInWorkspace(jobId, workspaceId);
    if (job.status === JobStatus.CANCEL_REQUESTED || isTerminalJobStatus(job.status)) {
      return toPublicJob(job);
    }

    assertValidJobStatusTransition(job.status, JobStatus.CANCEL_REQUESTED);
    return toPublicJob(await JobRepository.updateJob(job.id, {
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
    }));
  },

  async markCancelled(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.CANCELLED || isTerminalJobStatus(job.status)) return job;

    assertValidJobStatusTransition(job.status, JobStatus.CANCELLED);
    return JobRepository.updateJob(job.id, {
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: job.completedAt ?? new Date(),
    });
  },

  async markSucceeded(
    jobId: number,
    result?: Prisma.InputJsonValue,
    stage = 'completed',
  ): Promise<SelectedJob> {
    if (result !== undefined) {
      assertJobDataIsSanitized(result, 'job result');
    }

    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.SUCCEEDED || isTerminalJobStatus(job.status)) return job;

    assertValidJobStatusTransition(job.status, JobStatus.SUCCEEDED);
    return JobRepository.updateJob(job.id, {
      status: JobStatus.SUCCEEDED,
      progress: 100,
      stage,
      ...(result !== undefined ? { result } : {}),
      completedAt: job.completedAt ?? new Date(),
    });
  },

  async markFailed(
    jobId: number,
    errorCode: string,
    sanitizedError: string,
  ): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.FAILED || isTerminalJobStatus(job.status)) return job;

    assertValidJobStatusTransition(job.status, JobStatus.FAILED);
    return JobRepository.updateJob(job.id, {
      status: JobStatus.FAILED,
      stage: 'failed',
      errorCode,
      sanitizedError,
      completedAt: job.completedAt ?? new Date(),
    });
  },

  async heartbeat(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.CANCEL_REQUESTED) {
      throw new InvalidInputError(
        'Job heartbeat can only be updated while running or cancellation is requested.',
        'JOB_HEARTBEAT_STATUS_INVALID',
      );
    }

    return JobRepository.updateJob(job.id, {
      heartbeatAt: new Date(),
    });
  },
};

export function toPublicJob(job: SelectedJob): PublicJob {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    type: job.type,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    result: job.result,
    errorCode: job.errorCode,
    sanitizedError: job.sanitizedError,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdByUserId: job.createdByUserId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    heartbeatAt: job.heartbeatAt,
    cancelRequestedAt: job.cancelRequestedAt,
  };
}

async function getExistingJob(jobId: number): Promise<SelectedJob> {
  const job = await JobRepository.findById(jobId);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  return job;
}

async function getExistingJobInWorkspace(
  jobId: number,
  workspaceId: number,
): Promise<SelectedJob> {
  const job = await JobRepository.findByIdInWorkspace(jobId, workspaceId);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  return job;
}

function markEnqueueFailed(
  jobId: number,
  db?: Parameters<typeof JobRepository.updateJob>[2],
): Promise<SelectedJob> {
  return JobRepository.updateJob(jobId, {
    status: JobStatus.FAILED,
    stage: 'enqueue_failed',
    errorCode: ENQUEUE_FAILED_ERROR_CODE,
    sanitizedError: ENQUEUE_FAILED_ERROR_MESSAGE,
    completedAt: new Date(),
  }, db);
}
