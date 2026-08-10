import type { JobWithMetadata } from 'pg-boss';
import { JobStatus, WorkspaceType } from '@prisma/client';
import { JobQueuePayload, runJobWorker } from '../../../modules/job';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';

function createQueueJob(
  jobId: number,
  overrides: Partial<JobWithMetadata<JobQueuePayload>> = {},
): JobWithMetadata<JobQueuePayload> {
  const abortController = new AbortController();
  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    id: `pgboss-${jobId}`,
    name: 'validation.fixture',
    data: { jobId },
    expireInSeconds: 900,
    heartbeatSeconds: null,
    signal: abortController.signal,
    priority: 0,
    state: 'active',
    retryLimit: 2,
    retryCount: 0,
    retryDelay: 0,
    retryBackoff: false,
    startAfter: now,
    startedOn: now,
    singletonKey: null,
    singletonOn: null,
    deleteAfterSeconds: 60,
    createdOn: now,
    completedOn: null,
    keepUntil: now,
    policy: 'standard',
    heartbeatOn: null,
    blocked: false,
    blocking: false,
    pendingDependencies: 0,
    deadLetter: '',
    output: {},
    sourceName: null,
    sourceId: null,
    sourceCreatedOn: null,
    sourceRetryCount: null,
    ...overrides,
  } as JobWithMetadata<JobQueuePayload>;
}

beforeEach(async () => {
  await resetIntegrationDatabase();
});

async function createJobOwnerAndWorkspace() {
  const owner = await createIntegrationTestUser();
  const workspace = await integrationPrisma.workspace.create({
    data: {
      name: 'Job Worker Workspace',
      type: WorkspaceType.STANDARD,
      ownerUserId: owner.id,
    },
  });

  return { owner, workspace };
}

async function createQueuedJob(maxAttempts = 3) {
  const { owner, workspace } = await createJobOwnerAndWorkspace();
  return integrationPrisma.job.create({
    data: {
      workspaceId: workspace.id,
      createdByUserId: owner.id,
      type: 'validation.fixture',
      payload: { operationId: 'worker-lifecycle' },
      queueMessageId: 'pgboss-test',
      maxAttempts,
    },
  });
}

describe('Job worker lifecycle integration', () => {
  it('records worker pickup and successful completion in durable app state', async () => {
    const job = await createQueuedJob(2);

    await runJobWorker(createQueueJob(job.id), async ({ job: appJob }) => {
      expect(appJob.id).toBe(job.id);
      return { processedCount: 1 };
    });

    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.SUCCEEDED,
      attempts: 1,
      progress: 100,
      stage: 'completed',
      result: { processedCount: 1 },
    });
  });

  it('keeps non-final handler failures retry pending for pg-boss retry', async () => {
    const job = await createQueuedJob(3);

    await expect(
      runJobWorker(createQueueJob(job.id), async () => {
        throw new Error('raw retry failure');
      }),
    ).rejects.toThrow('raw retry failure');

    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.RUNNING,
      attempts: 1,
      stage: 'retry_pending',
      errorCode: null,
      sanitizedError: null,
    });
  });

  it('marks exhausted handler failures failed with sanitized details', async () => {
    const job = await createQueuedJob(1);

    await expect(
      runJobWorker(createQueueJob(job.id, { retryCount: 0, retryLimit: 0 }), async () => {
        throw new Error('password=secret final failure');
      }),
    ).rejects.toThrow('password=secret final failure');

    const failedJob = await integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(failedJob).toMatchObject({
      status: JobStatus.FAILED,
      attempts: 1,
      stage: 'failed',
      errorCode: 'JOB_HANDLER_FAILED',
      sanitizedError: 'Job handler failed.',
    });
    expect(JSON.stringify(failedJob)).not.toContain('secret');
  });

  it('persists explicit heartbeat checkpoints during work', async () => {
    const job = await createQueuedJob(2);
    const touchJob = jest.fn(async () => undefined);

    await runJobWorker(
      createQueueJob(job.id),
      async ({ heartbeat }) => {
        await heartbeat();
        return undefined;
      },
      { touchJob },
    );

    const completedJob = await integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completedJob.status).toBe(JobStatus.SUCCEEDED);
    expect(completedJob.heartbeatAt).not.toBeNull();
    expect(touchJob).toHaveBeenCalledWith('validation.fixture', `pgboss-${job.id}`);
  });

  it('turns cancellation checkpoints into durable cancellation without retry', async () => {
    const job = await createQueuedJob(2);
    await integrationPrisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.CANCEL_REQUESTED,
        stage: 'cancellation_requested',
        cancelRequestedAt: new Date(),
      },
    });

    const handler = jest.fn();
    await expect(runJobWorker(createQueueJob(job.id), handler)).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      attempts: 0,
    });
  });
});
