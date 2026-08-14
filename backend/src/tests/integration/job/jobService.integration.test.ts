import { JobMetricOutcome, JobStatus, WorkspaceType } from '@prisma/client';
import {
  JobQueuePayload,
  JobQueueTransport,
  JobService,
} from '../../../modules/job';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';

class FakeQueueTransport implements JobQueueTransport {
  public sends: Array<{ queueName: string; data: JobQueuePayload }> = [];
  private readonly responses: Array<string | null | Error>;

  constructor(...responses: Array<string | null | Error>) {
    this.responses = responses;
  }

  async send(queueName: string, data: JobQueuePayload): Promise<string | null> {
    this.sends.push({ queueName, data });
    const response =
      this.responses.length > 0 ? this.responses.shift() : `message-${data.jobId}`;
    if (response instanceof Error) throw response;
    return response ?? null;
  }
}

class BlockingQueueTransport implements JobQueueTransport {
  public sends: Array<{ queueName: string; data: JobQueuePayload }> = [];
  private releaseSend: (() => void) | undefined;
  public readonly sendStarted: Promise<void>;
  private notifySendStarted: (() => void) | undefined;

  constructor(private readonly messageId: string) {
    this.sendStarted = new Promise((resolve) => {
      this.notifySendStarted = resolve;
    });
  }

  async send(queueName: string, data: JobQueuePayload): Promise<string | null> {
    this.sends.push({ queueName, data });
    this.notifySendStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
    return this.messageId;
  }

  release(): void {
    this.releaseSend?.();
  }
}

beforeEach(async () => {
  await resetIntegrationDatabase();
});

async function createJobOwnerAndWorkspace() {
  const owner = await createIntegrationTestUser();
  const workspace = await integrationPrisma.workspace.create({
    data: {
      name: 'Job Service Workspace',
      type: WorkspaceType.STANDARD,
      ownerUserId: owner.id,
    },
  });

  return { owner, workspace };
}

describe('JobService integration', () => {
  it('persists authoritative app job state while pg-boss receives only the job id', async () => {
    const { owner, workspace } = await createJobOwnerAndWorkspace();
    const transport = new FakeQueueTransport('pgboss-1');

    const job = await JobService.enqueueJob(
      {
        workspaceId: workspace.id,
        createdByUserId: owner.id,
        type: 'provider.health.sample',
        payload: {
          providerId: 5,
          operationId: 'sample-1',
        },
      },
      transport,
    );

    expect(job).toMatchObject({
      workspaceId: workspace.id,
      createdByUserId: owner.id,
      status: JobStatus.QUEUED,
      queueMessageId: 'pgboss-1',
    });
    expect(transport.sends).toEqual([
      {
        queueName: 'provider.health.sample',
        data: { jobId: job.id },
      },
    ]);

    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.QUEUED,
      queueMessageId: 'pgboss-1',
      payload: {
        providerId: 5,
        operationId: 'sample-1',
      },
    });
  });

  it('makes enqueue failures visible without leaking queue error details', async () => {
    const { owner, workspace } = await createJobOwnerAndWorkspace();
    const transport = new FakeQueueTransport(new Error('password=secret failed'));

    const job = await JobService.enqueueJob(
      {
        workspaceId: workspace.id,
        createdByUserId: owner.id,
        type: 'validation.fixture',
        payload: { operationId: 'enqueue-failure' },
      },
      transport,
    );

    expect(job).toMatchObject({
      status: JobStatus.FAILED,
      errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
      sanitizedError: 'Job queue enqueue failed.',
      queueMessageId: null,
    });
    expect(JSON.stringify(job)).not.toContain('secret');
  });

  it('reconciles queued jobs without queue message ids and remains idempotent', async () => {
    const { owner, workspace } = await createJobOwnerAndWorkspace();
    const stranded = await integrationPrisma.job.create({
      data: {
        workspaceId: workspace.id,
        createdByUserId: owner.id,
        type: 'validation.reconcile',
        payload: { operationId: 'stranded' },
      },
    });
    const transport = new FakeQueueTransport('reconciled-message');

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: false, scanned: 1, reenqueued: 1, failed: 0 });
    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: stranded.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.QUEUED,
      queueMessageId: 'reconciled-message',
    });

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: false, scanned: 0, reenqueued: 0, failed: 0 });
  });

  it('serializes concurrent reconciliation with an advisory lock', async () => {
    const { owner, workspace } = await createJobOwnerAndWorkspace();
    await integrationPrisma.job.create({
      data: {
        workspaceId: workspace.id,
        createdByUserId: owner.id,
        type: 'validation.reconcile.concurrent',
        payload: { operationId: 'stranded-concurrent' },
      },
    });
    const blockingTransport = new BlockingQueueTransport('locked-message');
    const skippedTransport = new FakeQueueTransport('should-not-send');

    const firstReconciliation =
      JobService.reconcileQueuedJobsWithoutQueueMessage(blockingTransport);
    await blockingTransport.sendStarted;

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(skippedTransport),
    ).resolves.toEqual({ skipped: true, scanned: 0, reenqueued: 0, failed: 0 });

    blockingTransport.release();
    await expect(firstReconciliation).resolves.toEqual({
      skipped: false,
      scanned: 1,
      reenqueued: 1,
      failed: 0,
    });
    expect(skippedTransport.sends).toEqual([]);
  });

  it('persists lifecycle transitions through terminal states', async () => {
    const { owner, workspace } = await createJobOwnerAndWorkspace();
    const job = await integrationPrisma.job.create({
      data: {
        workspaceId: workspace.id,
        createdByUserId: owner.id,
        type: 'validation.lifecycle',
      },
    });

    await expect(JobService.markRunning(job.id)).resolves.toMatchObject({
      status: JobStatus.RUNNING,
      attempts: 1,
      stage: 'running',
    });
    await expect(JobService.updateProgress(job.id, 30, 'processing')).resolves.toMatchObject({
      progress: 30,
      stage: 'processing',
    });
    await expect(JobService.heartbeat(job.id)).resolves.toMatchObject({
      status: JobStatus.RUNNING,
    });
    await expect(
      JobService.markSucceeded(job.id, { processedCount: 2 }),
    ).resolves.toMatchObject({
      status: JobStatus.SUCCEEDED,
      progress: 100,
      result: { processedCount: 2 },
    });
    await expect(JobService.requestCancellation(job.id)).resolves.toMatchObject({
      status: JobStatus.SUCCEEDED,
    });
    await expect(
      integrationPrisma.jobMetric.findUniqueOrThrow({ where: { jobId: job.id } }),
    ).resolves.toMatchObject({
      jobId: job.id,
      workspaceId: workspace.id,
      jobType: 'validation.lifecycle',
      outcome: JobMetricOutcome.SUCCEEDED,
      attempts: 1,
      errorCode: null,
    });
  });
});
