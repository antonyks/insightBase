import { Prisma, JobStatus } from '@prisma/client';
import { logger } from '../../config/logger';
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
  JobQueueSendOptions,
  JobQueueTransport,
  JobReconciliationResult,
  PublicJob,
  StaleRunningJobRecoveryResult,
} from './job.types';
import { bestEffortNotifyJobChanged, JobNotificationHint } from './job.notifications';
import { JobMetricOutcome, JobMetricService } from '../jobMetric';

const ENQUEUE_FAILED_ERROR_CODE = 'JOB_QUEUE_ENQUEUE_FAILED';
const ENQUEUE_FAILED_ERROR_MESSAGE = 'Job queue enqueue failed.';
const HANDLER_FAILED_ERROR_CODE = 'JOB_HANDLER_FAILED';
const HANDLER_FAILED_ERROR_MESSAGE = 'Job handler failed.';
const STALE_WORKER_ERROR_CODE = 'JOB_WORKER_STALE';
const STALE_WORKER_ERROR_MESSAGE = 'Job worker became stale.';
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
    const maxAttempts = input.maxAttempts ?? 1;
    assertJobDataIsSanitized(payload);

    const job = await JobRepository.createQueuedJob({
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      type: input.type,
      payload,
      maxAttempts,
      stage: input.stage ?? 'queued',
    });
    await bestEffortNotifyJobChanged(job.id, 'queued');

    let queueMessageId: string | null;
    try {
      queueMessageId = await queueTransport.send(
        input.queueName ?? input.type,
        { jobId: job.id },
        createJobQueueSendOptions(maxAttempts),
      );

      if (!queueMessageId) {
        throw new Error('pg-boss did not return a message identifier.');
      }
    } catch {
      const failedJob = await markEnqueueFailed(job.id);
      await bestEffortNotifyJobChanged(failedJob.id, 'enqueue_failed');
      return failedJob;
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
          queueMessageId = await queueTransport.send(
            job.type,
            { jobId: job.id },
            createJobQueueSendOptions(job.maxAttempts),
          );

          if (!queueMessageId) {
            throw new Error('pg-boss did not return a message identifier.');
          }
        } catch {
          const failedJob = await markEnqueueFailed(job.id, db);
          await bestEffortNotifyJobChanged(failedJob.id, 'enqueue_failed');
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

  async recoverStaleRunningJobs(
    queueTransport: JobQueueTransport,
    options: { staleJobMs: number; limit?: number; now?: Date },
  ): Promise<StaleRunningJobRecoveryResult> {
    assertPositiveInteger(options.staleJobMs, 'staleJobMs');
    const now = options.now ?? new Date();
    const staleBefore = new Date(now.getTime() - options.staleJobMs);

    return JobRepository.runWithStaleRunningJobRecoveryLock(async (lockAcquired, db) => {
      if (!lockAcquired) {
        return {
          skipped: true,
          scanned: 0,
          requeued: 0,
          failed: 0,
        };
      }

      const staleJobs = await JobRepository.findStaleRunningJobs(
        staleBefore,
        options.limit ?? DEFAULT_RECONCILIATION_LIMIT,
        db,
      );
      const result: StaleRunningJobRecoveryResult = {
        skipped: false,
        scanned: staleJobs.length,
        requeued: 0,
        failed: 0,
      };

      for (const job of staleJobs) {
        if (job.attempts >= job.maxAttempts) {
          await finalizeJobAndNotify(job.id, {
            status: JobStatus.FAILED,
            stage: 'failed',
            errorCode: STALE_WORKER_ERROR_CODE,
            sanitizedError: STALE_WORKER_ERROR_MESSAGE,
            completedAt: job.completedAt ?? now,
          }, 'failed', db);
          result.failed += 1;
          continue;
        }

        let queueMessageId: string | null;
        try {
          queueMessageId = await queueTransport.send(
            job.type,
            { jobId: job.id },
            createJobQueueSendOptions(job.maxAttempts),
          );

          if (!queueMessageId) {
            throw new Error('pg-boss did not return a message identifier.');
          }
        } catch {
          await finalizeJobAndNotify(job.id, {
            status: JobStatus.FAILED,
            stage: 'enqueue_failed',
            errorCode: ENQUEUE_FAILED_ERROR_CODE,
            sanitizedError: ENQUEUE_FAILED_ERROR_MESSAGE,
            completedAt: now,
          }, 'enqueue_failed', db);
          result.failed += 1;
          continue;
        }

        await updateJobAndNotify(job.id, {
          status: JobStatus.QUEUED,
          stage: 'stale_requeued',
          queueMessageId,
        }, 'queued', db);
        result.requeued += 1;
      }

      return result;
    });
  },

  async markRunning(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.RUNNING) return job;

    assertValidJobStatusTransition(job.status, JobStatus.RUNNING);
    return updateJobAndNotify(job.id, {
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? new Date(),
      heartbeatAt: new Date(),
    }, 'running');
  },

  async startWorkerAttempt(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (isTerminalJobStatus(job.status)) return job;
    if (job.status === JobStatus.CANCEL_REQUESTED) {
      return markCancelledAndNotify(job.id);
    }

    if (job.status !== JobStatus.QUEUED && job.status !== JobStatus.RUNNING) {
      throw new InvalidInputError(
        `Job cannot start a worker attempt from status ${job.status}.`,
        'JOB_WORKER_ATTEMPT_STATUS_INVALID',
      );
    }

    return updateJobAndNotify(job.id, {
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? new Date(),
      heartbeatAt: new Date(),
    }, 'running');
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

    return updateJobAndNotify(job.id, {
      progress,
      ...(stage ? { stage } : {}),
    }, 'progress');
  },

  async requestCancellation(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.CANCEL_REQUESTED || isTerminalJobStatus(job.status)) {
      return job;
    }

    assertValidJobStatusTransition(job.status, JobStatus.CANCEL_REQUESTED);
    return updateJobAndNotify(job.id, {
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
    }, 'cancellation_requested');
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
    return toPublicJob(await updateJobAndNotify(job.id, {
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
    }, 'cancellation_requested'));
  },

  async markCancelled(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.CANCELLED || isTerminalJobStatus(job.status)) return job;

    assertValidJobStatusTransition(job.status, JobStatus.CANCELLED);
    return finalizeJobAndNotify(job.id, {
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: job.completedAt ?? new Date(),
    }, 'cancelled');
  },

  async checkpointCancellation(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.CANCEL_REQUESTED) {
      return markCancelledAndNotify(job.id);
    }
    return job;
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
    return finalizeJobAndNotify(job.id, {
      status: JobStatus.SUCCEEDED,
      progress: 100,
      stage,
      ...(result !== undefined ? { result } : {}),
      completedAt: job.completedAt ?? new Date(),
    }, 'succeeded');
  },

  async markFailed(
    jobId: number,
    errorCode: string,
    sanitizedError: string,
  ): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status === JobStatus.FAILED || isTerminalJobStatus(job.status)) return job;

    assertValidJobStatusTransition(job.status, JobStatus.FAILED);
    return finalizeJobAndNotify(job.id, {
      status: JobStatus.FAILED,
      stage: 'failed',
      errorCode,
      sanitizedError,
      completedAt: job.completedAt ?? new Date(),
    }, 'failed');
  },

  async markRetryPending(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (isTerminalJobStatus(job.status)) return job;

    if (job.status !== JobStatus.RUNNING) {
      throw new InvalidInputError(
        'Job retry can only be pending after a running attempt.',
        'JOB_RETRY_PENDING_STATUS_INVALID',
      );
    }

    return updateJobAndNotify(job.id, {
      status: JobStatus.RUNNING,
      stage: 'retry_pending',
    }, 'running');
  },

  async markHandlerFailed(jobId: number): Promise<SelectedJob> {
    return this.markFailed(jobId, HANDLER_FAILED_ERROR_CODE, HANDLER_FAILED_ERROR_MESSAGE);
  },

  async heartbeat(jobId: number): Promise<SelectedJob> {
    const job = await getExistingJob(jobId);
    if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.CANCEL_REQUESTED) {
      throw new InvalidInputError(
        'Job heartbeat can only be updated while running or cancellation is requested.',
        'JOB_HEARTBEAT_STATUS_INVALID',
      );
    }

    return updateJobAndNotify(job.id, {
      heartbeatAt: new Date(),
    }, 'heartbeat');
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
  return finalizeJob(jobId, {
    status: JobStatus.FAILED,
    stage: 'enqueue_failed',
    errorCode: ENQUEUE_FAILED_ERROR_CODE,
    sanitizedError: ENQUEUE_FAILED_ERROR_MESSAGE,
    completedAt: new Date(),
  }, db);
}

function markCancelledAndNotify(jobId: number): Promise<SelectedJob> {
  return finalizeJobAndNotify(jobId, {
    status: JobStatus.CANCELLED,
    stage: 'cancelled',
    completedAt: new Date(),
  }, 'cancelled');
}

async function updateJobAndNotify(
  jobId: number,
  data: Prisma.JobUpdateInput,
  notificationHint: JobNotificationHint,
  db?: Parameters<typeof JobRepository.updateJob>[2],
): Promise<SelectedJob> {
  const job = await JobRepository.updateJob(jobId, data, db);
  await bestEffortNotifyJobChanged(job.id, notificationHint);
  return job;
}

async function finalizeJob(
  jobId: number,
  data: Prisma.JobUpdateInput,
  db?: Parameters<typeof JobRepository.updateJob>[2],
): Promise<SelectedJob> {
  const job = await JobRepository.updateJob(jobId, data, db);
  await recordJobMetricSafely(job, db);
  return job;
}

async function finalizeJobAndNotify(
  jobId: number,
  data: Prisma.JobUpdateInput,
  notificationHint: JobNotificationHint,
  db?: Parameters<typeof JobRepository.updateJob>[2],
): Promise<SelectedJob> {
  const job = await updateJobAndNotify(jobId, data, notificationHint, db);
  await recordJobMetricSafely(job, db);
  return job;
}

async function recordJobMetricSafely(
  job: SelectedJob,
  db?: Parameters<typeof JobMetricService.recordFinalizedJob>[1],
): Promise<void> {
  const outcome = toJobMetricOutcome(job.status);
  if (!outcome) return;

  try {
    await JobMetricService.recordFinalizedJob({
      jobId: job.id,
      workspaceId: job.workspaceId,
      jobType: job.type,
      outcome,
      attempts: job.attempts,
      queueWaitMs: differenceMs(job.startedAt, job.createdAt),
      executionDurationMs: differenceMs(job.completedAt, job.startedAt),
      errorCode: job.errorCode ?? undefined,
    }, db);
  } catch (error) {
    logger.error({
      err: error,
      jobId: job.id,
      workspaceId: job.workspaceId,
      jobType: job.type,
      outcome,
      operation: 'jobMetric.record',
      status: 'error',
    }, 'Job metric recording failed.');
  }
}

function toJobMetricOutcome(status: JobStatus): JobMetricOutcome | null {
  if (status === JobStatus.SUCCEEDED) return JobMetricOutcome.SUCCEEDED;
  if (status === JobStatus.FAILED) return JobMetricOutcome.FAILED;
  if (status === JobStatus.CANCELLED) return JobMetricOutcome.CANCELLED;
  return null;
}

function differenceMs(end: Date | null, start: Date | null): number | undefined {
  if (!end || !start) return undefined;
  return end.getTime() - start.getTime();
}

function createJobQueueSendOptions(maxAttempts: number): JobQueueSendOptions {
  return {
    retryLimit: Math.max(maxAttempts - 1, 0),
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidInputError(`${name} must be a positive integer.`, 'JOB_RECOVERY_INPUT_INVALID');
  }
}
