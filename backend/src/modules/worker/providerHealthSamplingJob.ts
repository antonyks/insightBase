import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { logger } from '../../config/logger';
import { prisma } from '../../config/database';
import { WorkspaceProvisioningService } from '../workspace/workspaceProvisioning.service';
import { JobQueueTransport, JobService } from '../job';
import { JobRepository } from '../job/job.repository';
import { JobWorkerHandler } from '../job/job.worker';
import { LlmRuntimeService } from '../llm/llmRuntime.service';

export const PROVIDER_HEALTH_SAMPLING_JOB_TYPE = 'system.provider_health_sample';
export const PROVIDER_HEALTH_SAMPLING_JOB_QUEUE = PROVIDER_HEALTH_SAMPLING_JOB_TYPE;
export const PROVIDER_HEALTH_SAMPLING_JOB_MAX_ATTEMPTS = 1;

export type ProviderHealthSamplingEnqueueResult =
  | { skipped: false; jobId: number }
  | { skipped: true; reason: 'lock_not_acquired' | 'job_already_pending' | 'missing_admin_owner' };

export interface ProviderHealthSamplingScheduler {
  stop: () => void;
}

export async function enqueueProviderHealthSamplingJob(
  queueTransport: JobQueueTransport,
): Promise<ProviderHealthSamplingEnqueueResult> {
  const owner = await findProviderHealthSamplingJobOwner();
  if (!owner) {
    logger.warn(
      { jobType: PROVIDER_HEALTH_SAMPLING_JOB_TYPE },
      'Provider health sampling job enqueue skipped because no active admin owner exists.',
    );
    return { skipped: true, reason: 'missing_admin_owner' };
  }

  return JobRepository.runWithProviderHealthSamplingEnqueueLock(async (lockAcquired, db) => {
    if (!lockAcquired) {
      return { skipped: true, reason: 'lock_not_acquired' };
    }

    const existingJob = await JobRepository.findLatestNonTerminalJobByType(
      PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
      db,
    );

    if (existingJob) {
      return { skipped: true, reason: 'job_already_pending' };
    }

    const job = await JobService.enqueueJob({
      workspaceId: owner.workspaceId,
      createdByUserId: owner.userId,
      type: PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
      queueName: PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
      payload: {},
      maxAttempts: PROVIDER_HEALTH_SAMPLING_JOB_MAX_ATTEMPTS,
      stage: 'provider_health_sample_queued',
    }, queueTransport);

    return { skipped: false, jobId: job.id };
  });
}

export function createProviderHealthSamplingJobHandler(): JobWorkerHandler {
  return async ({ job, heartbeat, checkpointCancellation }) => {
    await checkpointCancellation();
    await JobService.updateProgress(job.id, 10, 'provider_health_sampling_started');
    await heartbeat();

    const result = await sampleProviderHealth();

    await checkpointCancellation();
    await JobService.updateProgress(job.id, 90, 'provider_health_sampling_recorded');
    await heartbeat();

    return result;
  };
}

export function startProviderHealthSamplingScheduler(params: {
  intervalMs: number;
  queueTransport: JobQueueTransport;
}): ProviderHealthSamplingScheduler {
  let stopped = false;
  let tickInFlight = false;

  const runTick = async (): Promise<void> => {
    if (stopped || tickInFlight) return;

    tickInFlight = true;
    try {
      const result = await enqueueProviderHealthSamplingJob(params.queueTransport);
      logger.info(
        {
          jobType: PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
          result,
        },
        'Provider health sampling enqueue tick completed.',
      );
    } catch (error) {
      logger.error(
        {
          err: error,
          jobType: PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
        },
        'Provider health sampling enqueue tick failed.',
      );
    } finally {
      tickInFlight = false;
    }
  };

  void runTick();
  const interval = setInterval(() => {
    void runTick();
  }, params.intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
    },
  };
}

async function sampleProviderHealth(): Promise<Prisma.JsonObject> {
  const modelRegistry = await LlmRuntimeService.listAvailableModels();
  const success = modelRegistry.providers.filter((provider) => provider.status === 'success').length;
  const error = modelRegistry.providers.filter((provider) => provider.status === 'error').length;
  const skipped = modelRegistry.providers.filter((provider) => provider.status === 'skipped').length;

  return {
    providers: modelRegistry.providers.length,
    success,
    error,
    skipped,
  };
}

async function findProviderHealthSamplingJobOwner(): Promise<{
  userId: number;
  workspaceId: number;
} | null> {
  const admin = await prisma.user.findFirst({
    where: {
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  if (!admin) return null;

  const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(admin.id);

  return {
    userId: admin.id,
    workspaceId: workspace.id,
  };
}
