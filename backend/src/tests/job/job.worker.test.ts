import type { JobWithMetadata } from 'pg-boss';
import { JobStatus } from '@prisma/client';
import {
  JobQueuePayload,
  JobWorkerCancelledError,
  JobWorkerShutdownError,
  runJobWorker,
  SelectedJob,
} from '../../modules/job';
import { mockPrisma } from '../setup';

function createJob(overrides: Partial<SelectedJob> = {}): SelectedJob {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1,
    workspaceId: 10,
    type: 'validation.fixture',
    status: JobStatus.RUNNING,
    progress: 0,
    stage: 'running',
    payload: { operationId: 'safe' },
    result: null,
    errorCode: null,
    sanitizedError: null,
    attempts: 1,
    maxAttempts: 3,
    queueMessageId: 'pgboss-1',
    createdByUserId: 20,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    heartbeatAt: now,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function createQueueJob(
  overrides: Partial<JobWithMetadata<JobQueuePayload>> = {},
): JobWithMetadata<JobQueuePayload> {
  const abortController = new AbortController();
  const now = new Date('2026-01-01T00:00:00.000Z');

  return {
    id: 'pgboss-1',
    name: 'validation.fixture',
    data: { jobId: 1 },
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
    ...overrides,
  } as JobWithMetadata<JobQueuePayload>;
}

describe('job worker lifecycle wrapper', () => {
  it('records an attempt and marks successful work as succeeded', async () => {
    const running = createJob();
    const succeeded = createJob({
      status: JobStatus.SUCCEEDED,
      stage: 'completed',
      progress: 100,
      result: { processedCount: 1 },
      completedAt: new Date(),
    });
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(succeeded);

    await expect(
      runJobWorker(
        createQueueJob(),
        async ({ job, payload }) => {
          expect(job.id).toBe(1);
          expect(payload).toEqual({ operationId: 'safe' });
          return { processedCount: 1 };
        },
      ),
    ).resolves.toBeUndefined();

    expect(mockPrisma.job.update).toHaveBeenNthCalledWith(1, {
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.RUNNING,
        stage: 'running',
        attempts: { increment: 1 },
      }),
      select: expect.objectContaining({ id: true }),
    });
    expect(mockPrisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.SUCCEEDED,
        progress: 100,
        result: { processedCount: 1 },
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('marks non-final handler failures retry pending and rethrows for pg-boss retry', async () => {
    const running = createJob({ attempts: 1, maxAttempts: 3 });
    const retryPending = createJob({ attempts: 1, maxAttempts: 3, stage: 'retry_pending' });
    const handlerError = new Error('password=secret upstream failure');
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(retryPending);

    await expect(
      runJobWorker(createQueueJob(), async () => {
        throw handlerError;
      }),
    ).rejects.toThrow(handlerError);

    expect(mockPrisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 1 },
      data: {
        status: JobStatus.RUNNING,
        stage: 'retry_pending',
      },
      select: expect.objectContaining({ id: true }),
    });
    expect(JSON.stringify(mockPrisma.job.update.mock.calls)).not.toContain('secret');
  });

  it('marks exhausted handler failures failed with sanitized app error and rethrows', async () => {
    const running = createJob({ attempts: 2, maxAttempts: 2 });
    const failed = createJob({
      attempts: 2,
      maxAttempts: 2,
      status: JobStatus.FAILED,
      stage: 'failed',
      errorCode: 'JOB_HANDLER_FAILED',
      sanitizedError: 'Job handler failed.',
      completedAt: new Date(),
    });
    const handlerError = new Error('raw handler details');
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(failed);

    await expect(
      runJobWorker(createQueueJob({ retryCount: 1, retryLimit: 1 }), async () => {
        throw handlerError;
      }),
    ).rejects.toThrow(handlerError);

    expect(mockPrisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        stage: 'failed',
        errorCode: 'JOB_HANDLER_FAILED',
        sanitizedError: 'Job handler failed.',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('marks pre-work cancellation cancelled and does not run the handler', async () => {
    const cancelRequested = createJob({
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: new Date(),
    });
    const cancelled = createJob({
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: new Date(),
    });
    const handler = jest.fn();
    mockPrisma.job.findUnique.mockResolvedValue(cancelRequested);
    mockPrisma.job.update.mockResolvedValue(cancelled);

    await expect(runJobWorker(createQueueJob(), handler)).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.CANCELLED,
        stage: 'cancelled',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('gives handlers a reusable cancellation checkpoint', async () => {
    const running = createJob();
    const cancelRequested = createJob({
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
    });
    const cancelled = createJob({
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: new Date(),
    });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelRequested);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelled);

    await expect(
      runJobWorker(createQueueJob(), async ({ checkpointCancellation }) => {
        await expect(checkpointCancellation()).rejects.toThrow(JobWorkerCancelledError);
      }),
    ).resolves.toBeUndefined();

    expect(mockPrisma.job.update).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.CANCELLED,
        stage: 'cancelled',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('lets cancellation win over retry when a handler fails after cancellation is requested', async () => {
    const running = createJob();
    const cancelRequested = createJob({
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
    });
    const cancelled = createJob({
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: new Date(),
    });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelRequested);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelled);

    await expect(
      runJobWorker(createQueueJob(), async () => {
        throw new Error('ordinary handler failure after cancellation');
      }),
    ).resolves.toBeUndefined();

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.job.update).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.CANCELLED,
        stage: 'cancelled',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('updates app and pg-boss heartbeats from handler checkpoints', async () => {
    const running = createJob();
    const succeeded = createJob({ status: JobStatus.SUCCEEDED, progress: 100 });
    const touchJob = jest.fn(async () => undefined);
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(createJob({ heartbeatAt: new Date() }))
      .mockResolvedValueOnce(succeeded);

    await runJobWorker(
      createQueueJob(),
      async ({ heartbeat }) => {
        await heartbeat();
        return undefined;
      },
      { touchJob },
    );

    expect(touchJob).toHaveBeenCalledWith('validation.fixture', 'pgboss-1');
    expect(mockPrisma.job.update).toHaveBeenNthCalledWith(2, {
      where: { id: 1 },
      data: {
        heartbeatAt: expect.any(Date),
      },
      select: expect.objectContaining({ id: true }),
    });
  });

  it('does not mark terminal state when shutdown interrupts in-flight work', async () => {
    const running = createJob({ attempts: 1, maxAttempts: 3 });
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update.mockResolvedValue(running);

    await expect(
      runJobWorker(createQueueJob(), async () => {
        throw new JobWorkerShutdownError(1);
      }),
    ).rejects.toThrow(JobWorkerShutdownError);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: JobStatus.RUNNING,
        stage: 'running',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });
});
