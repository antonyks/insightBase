import { JobStatus } from '@prisma/client';
import { InvalidInputError, NotFoundError } from '../../errors';
import { logger } from '../../config/logger';
import { JobQueuePayload, JobQueueTransport, JobService, SelectedJob } from '../../modules/job';
import { mockPrisma } from '../setup';

class FakeQueueTransport implements JobQueueTransport {
  public sends: Array<{ queueName: string; data: JobQueuePayload }> = [];
  public sendOptions: unknown[] = [];
  private readonly responses: Array<string | null | Error>;

  constructor(...responses: Array<string | null | Error>) {
    this.responses = responses;
  }

  async send(queueName: string, data: JobQueuePayload, options?: unknown): Promise<string | null> {
    this.sends.push({ queueName, data });
    this.sendOptions.push(options);
    const response =
      this.responses.length > 0 ? this.responses.shift() : 'pgboss-message-id';
    if (response instanceof Error) throw response;
    return response ?? null;
  }
}

function createJob(overrides: Partial<SelectedJob> = {}): SelectedJob {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1,
    workspaceId: 10,
    type: 'validation.fixture',
    status: JobStatus.QUEUED,
    progress: 0,
    stage: 'queued',
    payload: {},
    result: null,
    errorCode: null,
    sanitizedError: null,
    attempts: 0,
    maxAttempts: 1,
    queueMessageId: null,
    createdByUserId: 20,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe('JobService', () => {
  it('reads jobs through the request workspace and returns a public DTO', async () => {
    const job = createJob({
      id: 31,
      workspaceId: 10,
      payload: { operationId: 'internal-payload' },
      queueMessageId: 'pgboss-internal-id',
      result: { processedCount: 2 },
    });
    mockPrisma.job.findFirst.mockResolvedValue(job);

    const result = await JobService.getJobInWorkspace(31, 10);

    expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
      where: {
        id: 31,
        workspaceId: 10,
      },
      select: expect.objectContaining({ id: true, workspaceId: true }),
    });
    expect(result).toMatchObject({
      id: 31,
      workspaceId: 10,
      result: { processedCount: 2 },
    });
    expect(result).not.toHaveProperty('payload');
    expect(result).not.toHaveProperty('queueMessageId');
  });

  it('throws not found when a job is missing from the request workspace', async () => {
    mockPrisma.job.findFirst.mockResolvedValue(null);

    await expect(JobService.getJobInWorkspace(31, 999)).rejects.toThrow(
      new NotFoundError('Job not found'),
    );
  });

  it('requests cancellation through a workspace-scoped job lookup', async () => {
    const queued = createJob({ id: 32, workspaceId: 10 });
    const cancelRequested = createJob({
      id: 32,
      workspaceId: 10,
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: new Date(),
    });
    mockPrisma.job.findFirst.mockResolvedValue(queued);
    mockPrisma.job.update.mockResolvedValue(cancelRequested);

    await expect(
      JobService.requestCancellationInWorkspace(32, 10),
    ).resolves.toMatchObject({
      id: 32,
      workspaceId: 10,
      status: JobStatus.CANCEL_REQUESTED,
    });

    expect(mockPrisma.job.findFirst).toHaveBeenCalledWith({
      where: {
        id: 32,
        workspaceId: 10,
      },
      select: expect.objectContaining({ id: true, workspaceId: true }),
    });
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 32 },
      data: expect.objectContaining({
        status: JobStatus.CANCEL_REQUESTED,
        stage: 'cancellation_requested',
        cancelRequestedAt: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('returns terminal jobs unchanged for workspace-scoped cancellation', async () => {
    const succeeded = createJob({
      id: 33,
      workspaceId: 10,
      status: JobStatus.SUCCEEDED,
      stage: 'completed',
      completedAt: new Date(),
    });
    mockPrisma.job.findFirst.mockResolvedValue(succeeded);

    await expect(
      JobService.requestCancellationInWorkspace(33, 10),
    ).resolves.toMatchObject({
      status: JobStatus.SUCCEEDED,
      stage: 'completed',
    });

    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('creates an application job, enqueues a minimal pg-boss payload, and stores the message id', async () => {
    const queued = createJob({ id: 77, type: 'provider.health.sample' });
    const queuedWithMessage = createJob({
      id: 77,
      type: 'provider.health.sample',
      queueMessageId: 'pgboss-77',
    });
    const transport = new FakeQueueTransport('pgboss-77');
    mockPrisma.job.create.mockResolvedValue(queued);
    mockPrisma.job.update.mockResolvedValue(queuedWithMessage);

    await expect(
      JobService.enqueueJob(
        {
          workspaceId: 10,
          createdByUserId: 20,
          type: 'provider.health.sample',
          payload: { providerId: 3 },
          maxAttempts: 2,
        },
        transport,
      ),
    ).resolves.toEqual(queuedWithMessage);

    expect(mockPrisma.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 10,
        createdByUserId: 20,
        type: 'provider.health.sample',
        status: JobStatus.QUEUED,
        payload: { providerId: 3 },
        maxAttempts: 2,
        stage: 'queued',
      }),
      select: expect.objectContaining({ id: true, queueMessageId: true }),
    });
    expect(transport.sends).toEqual([
      { queueName: 'provider.health.sample', data: { jobId: 77 } },
    ]);
    expect(transport.sendOptions).toEqual([{ retryLimit: 1 }]);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: { queueMessageId: 'pgboss-77' },
      select: expect.objectContaining({ id: true, queueMessageId: true }),
    });
  });

  it('does not mark the job failed when storing a successful queue message id fails', async () => {
    const queued = createJob({ id: 78 });
    const transport = new FakeQueueTransport('pgboss-78');
    const persistenceError = new Error('database update failed');
    mockPrisma.job.create.mockResolvedValue(queued);
    mockPrisma.job.update.mockRejectedValue(persistenceError);

    await expect(
      JobService.enqueueJob(
        {
          workspaceId: 10,
          createdByUserId: 20,
          type: 'validation.fixture',
          payload: { operationId: 'safe' },
        },
        transport,
      ),
    ).rejects.toThrow(persistenceError);

    expect(transport.sends).toEqual([
      { queueName: 'validation.fixture', data: { jobId: 78 } },
    ]);
    expect(transport.sendOptions).toEqual([{ retryLimit: 0 }]);
    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 78 },
      data: { queueMessageId: 'pgboss-78' },
      select: expect.objectContaining({ id: true }),
    });
  });

  it('marks the application job failed with a sanitized error when enqueue throws', async () => {
    const queued = createJob({ id: 88 });
    const failed = createJob({
      id: 88,
      status: JobStatus.FAILED,
      stage: 'enqueue_failed',
      errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
      sanitizedError: 'Job queue enqueue failed.',
      completedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const transport = new FakeQueueTransport(
      new Error('password=super-secret connection failed'),
    );
    mockPrisma.job.create.mockResolvedValue(queued);
    mockPrisma.job.update.mockResolvedValue(failed);

    await expect(
      JobService.enqueueJob(
        {
          workspaceId: 10,
          createdByUserId: 20,
          type: 'validation.fixture',
          payload: { operationId: 'safe' },
        },
        transport,
      ),
    ).resolves.toEqual(failed);

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 88 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        stage: 'enqueue_failed',
        errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
        sanitizedError: 'Job queue enqueue failed.',
        completedAt: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true }),
    });
    const updateCalls = mockPrisma.job.update.mock.calls as unknown as Array<
      [{ data: unknown }]
    >;
    expect(JSON.stringify(updateCalls[0][0].data)).not.toContain('super-secret');
  });

  it('rejects unsanitized enqueue payloads before creating a job', async () => {
    await expect(
      JobService.enqueueJob(
        {
          workspaceId: 10,
          createdByUserId: 20,
          type: 'validation.fixture',
          payload: { apiKey: 'secret' },
        },
        new FakeQueueTransport('unused'),
      ),
    ).rejects.toThrow(InvalidInputError);

    expect(mockPrisma.job.create).not.toHaveBeenCalled();
  });

  it('reconciles queued jobs without queue message ids idempotently', async () => {
    const jobs = [
      createJob({ id: 1, type: 'validation.one' }),
      createJob({ id: 2, type: 'validation.two' }),
    ];
    const transport = new FakeQueueTransport('message-1', 'message-2');
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValueOnce(jobs).mockResolvedValueOnce([]);
    mockPrisma.job.update
      .mockResolvedValueOnce(createJob({ id: 1, queueMessageId: 'message-1' }))
      .mockResolvedValueOnce(createJob({ id: 2, queueMessageId: 'message-2' }));

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: false, scanned: 2, reenqueued: 2, failed: 0 });
    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: false, scanned: 0, reenqueued: 0, failed: 0 });

    expect(transport.sends).toEqual([
      { queueName: 'validation.one', data: { jobId: 1 } },
      { queueName: 'validation.two', data: { jobId: 2 } },
    ]);
    expect(transport.sendOptions).toEqual([
      { retryLimit: 0 },
      { retryLimit: 0 },
    ]);
  });

  it('skips reconciliation without querying jobs when another worker holds the lock', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: false }]);
    const transport = new FakeQueueTransport('unused');

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: true, scanned: 0, reenqueued: 0, failed: 0 });

    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(transport.sends).toEqual([]);
  });

  it('marks reconciliation enqueue failures as visible failed jobs', async () => {
    const transport = new FakeQueueTransport(null);
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValue([createJob({ id: 9 })]);
    mockPrisma.job.update.mockResolvedValue(
      createJob({
        id: 9,
        status: JobStatus.FAILED,
        errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
        sanitizedError: 'Job queue enqueue failed.',
      }),
    );

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).resolves.toEqual({ skipped: false, scanned: 1, reenqueued: 0, failed: 1 });

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
        sanitizedError: 'Job queue enqueue failed.',
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('does not mark reconciliation jobs failed when queue id persistence fails', async () => {
    const transport = new FakeQueueTransport('message-10');
    const persistenceError = new Error('queue id persistence failed');
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValue([createJob({ id: 10 })]);
    mockPrisma.job.update.mockRejectedValue(persistenceError);

    await expect(
      JobService.reconcileQueuedJobsWithoutQueueMessage(transport),
    ).rejects.toThrow(persistenceError);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { queueMessageId: 'message-10' },
      select: expect.objectContaining({ id: true }),
    });
  });

  it('recovers stale running jobs by requeueing non-final attempts', async () => {
    const staleRunning = createJob({
      id: 41,
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      heartbeatAt: new Date('2026-01-01T00:01:00.000Z'),
      queueMessageId: 'old-message',
    });
    const transport = new FakeQueueTransport('new-message');
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValue([staleRunning]);
    mockPrisma.job.update.mockResolvedValue(createJob({
      id: 41,
      status: JobStatus.QUEUED,
      stage: 'stale_requeued',
      attempts: 1,
      maxAttempts: 3,
      queueMessageId: 'new-message',
    }));

    await expect(JobService.recoverStaleRunningJobs(
      transport,
      {
        staleJobMs: 30_000,
        now: new Date('2026-01-01T00:02:00.000Z'),
      },
    )).resolves.toEqual({ skipped: false, scanned: 1, requeued: 1, failed: 0 });

    expect(mockPrisma.job.findMany).toHaveBeenCalledWith({
      where: {
        status: JobStatus.RUNNING,
        OR: [
          {
            heartbeatAt: {
              lt: new Date('2026-01-01T00:01:30.000Z'),
            },
          },
          {
            heartbeatAt: null,
            startedAt: {
              lt: new Date('2026-01-01T00:01:30.000Z'),
            },
          },
        ],
      },
      orderBy: { startedAt: 'asc' },
      take: 100,
      select: expect.objectContaining({ id: true }),
    });
    expect(transport.sends).toEqual([
      { queueName: 'validation.fixture', data: { jobId: 41 } },
    ]);
    expect(transport.sendOptions).toEqual([{ retryLimit: 2 }]);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: {
        status: JobStatus.QUEUED,
        stage: 'stale_requeued',
        queueMessageId: 'new-message',
      },
      select: expect.objectContaining({ id: true }),
    });
  });

  it('marks exhausted stale running jobs failed with sanitized stale worker error', async () => {
    const staleExhausted = createJob({
      id: 42,
      status: JobStatus.RUNNING,
      attempts: 2,
      maxAttempts: 2,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      heartbeatAt: new Date('2026-01-01T00:00:30.000Z'),
    });
    const transport = new FakeQueueTransport('unused');
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValue([staleExhausted]);
    mockPrisma.job.update.mockResolvedValue(createJob({
      id: 42,
      status: JobStatus.FAILED,
      stage: 'failed',
      errorCode: 'JOB_WORKER_STALE',
      sanitizedError: 'Job worker became stale.',
    }));

    await expect(JobService.recoverStaleRunningJobs(
      transport,
      {
        staleJobMs: 30_000,
        now: new Date('2026-01-01T00:02:00.000Z'),
      },
    )).resolves.toEqual({ skipped: false, scanned: 1, requeued: 0, failed: 1 });

    expect(transport.sends).toEqual([]);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        stage: 'failed',
        errorCode: 'JOB_WORKER_STALE',
        sanitizedError: 'Job worker became stale.',
        completedAt: new Date('2026-01-01T00:02:00.000Z'),
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('marks stale requeue enqueue failures as visible failed jobs', async () => {
    const staleRunning = createJob({
      id: 43,
      status: JobStatus.RUNNING,
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const transport = new FakeQueueTransport(new Error('queue secret failed'));
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findMany.mockResolvedValue([staleRunning]);
    mockPrisma.job.update.mockResolvedValue(createJob({
      id: 43,
      status: JobStatus.FAILED,
      stage: 'enqueue_failed',
      errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
      sanitizedError: 'Job queue enqueue failed.',
    }));

    await expect(JobService.recoverStaleRunningJobs(
      transport,
      {
        staleJobMs: 30_000,
        now: new Date('2026-01-01T00:02:00.000Z'),
      },
    )).resolves.toEqual({ skipped: false, scanned: 1, requeued: 0, failed: 1 });

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 43 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        stage: 'enqueue_failed',
        errorCode: 'JOB_QUEUE_ENQUEUE_FAILED',
        sanitizedError: 'Job queue enqueue failed.',
      }),
      select: expect.objectContaining({ id: true }),
    });
    expect(JSON.stringify(mockPrisma.job.update.mock.calls)).not.toContain('secret');
  });

  it('skips stale running job recovery when another worker holds the lock', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: false }]);
    const transport = new FakeQueueTransport('unused');

    await expect(JobService.recoverStaleRunningJobs(
      transport,
      { staleJobMs: 30_000 },
    )).resolves.toEqual({ skipped: true, scanned: 0, requeued: 0, failed: 0 });

    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
    expect(transport.sends).toEqual([]);
  });

  it('rejects invalid stale running job recovery input', async () => {
    await expect(JobService.recoverStaleRunningJobs(
      new FakeQueueTransport('unused'),
      { staleJobMs: 0 },
    )).rejects.toThrow(InvalidInputError);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('runs jobs once and treats repeated running calls as idempotent', async () => {
    const queued = createJob({ id: 11 });
    const running = createJob({
      id: 11,
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: 1,
      startedAt: new Date(),
    });
    mockPrisma.job.findUnique.mockResolvedValueOnce(queued).mockResolvedValueOnce(running);
    mockPrisma.job.update.mockResolvedValue(running);

    await expect(JobService.markRunning(11)).resolves.toEqual(running);
    await expect(JobService.markRunning(11)).resolves.toEqual(running);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: expect.objectContaining({
        status: JobStatus.RUNNING,
        attempts: { increment: 1 },
        startedAt: expect.any(Date),
        heartbeatAt: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('records worker attempts even when retrying from a running retry-pending job', async () => {
    const retryPending = createJob({
      id: 35,
      status: JobStatus.RUNNING,
      stage: 'retry_pending',
      attempts: 1,
      maxAttempts: 3,
      startedAt: new Date(),
    });
    const secondAttempt = createJob({
      id: 35,
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: 2,
      maxAttempts: 3,
      startedAt: retryPending.startedAt,
      heartbeatAt: new Date(),
    });
    mockPrisma.job.findUnique.mockResolvedValue(retryPending);
    mockPrisma.job.update.mockResolvedValue(secondAttempt);

    await expect(JobService.startWorkerAttempt(35)).resolves.toEqual(secondAttempt);

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 35 },
      data: expect.objectContaining({
        status: JobStatus.RUNNING,
        stage: 'running',
        attempts: { increment: 1 },
        startedAt: retryPending.startedAt,
        heartbeatAt: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('keeps non-final worker failures visible as retry pending without raw error details', async () => {
    const running = createJob({
      id: 36,
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: 1,
      maxAttempts: 3,
    });
    const retryPending = createJob({
      id: 36,
      status: JobStatus.RUNNING,
      stage: 'retry_pending',
      attempts: 1,
      maxAttempts: 3,
    });
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update.mockResolvedValue(retryPending);

    await expect(JobService.markRetryPending(36)).resolves.toEqual(retryPending);

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 36 },
      data: {
        status: JobStatus.RUNNING,
        stage: 'retry_pending',
      },
      select: expect.objectContaining({ id: true }),
    });
    expect(JSON.stringify(mockPrisma.job.update.mock.calls)).not.toContain('password');
  });

  it('marks exhausted worker handler failures with a sanitized stable error', async () => {
    const running = createJob({
      id: 37,
      status: JobStatus.RUNNING,
      stage: 'running',
      attempts: 2,
      maxAttempts: 2,
    });
    const failed = createJob({
      id: 37,
      status: JobStatus.FAILED,
      stage: 'failed',
      errorCode: 'JOB_HANDLER_FAILED',
      sanitizedError: 'Job handler failed.',
      completedAt: new Date(),
    });
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update.mockResolvedValue(failed);

    await expect(JobService.markHandlerFailed(37)).resolves.toEqual(failed);

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 37 },
      data: expect.objectContaining({
        status: JobStatus.FAILED,
        stage: 'failed',
        errorCode: 'JOB_HANDLER_FAILED',
        sanitizedError: 'Job handler failed.',
        completedAt: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true }),
    });
  });

  it('persists progress, successful finalization, and heartbeat lifecycle updates', async () => {
    const running = createJob({ id: 12, status: JobStatus.RUNNING, stage: 'running' });
    const succeeded = createJob({
      id: 12,
      status: JobStatus.SUCCEEDED,
      progress: 100,
      stage: 'completed',
      result: { processedCount: 1 },
    });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(succeeded);
    mockPrisma.job.update
      .mockResolvedValueOnce(createJob({ id: 12, status: JobStatus.RUNNING, progress: 40 }))
      .mockResolvedValueOnce(createJob({ id: 12, status: JobStatus.RUNNING, heartbeatAt: new Date() }))
      .mockResolvedValueOnce(succeeded);

    await expect(JobService.updateProgress(12, 40, 'halfway')).resolves.toMatchObject({
      progress: 40,
    });
    await expect(JobService.heartbeat(12)).resolves.toMatchObject({
      status: JobStatus.RUNNING,
    });
    await expect(
      JobService.markSucceeded(12, { processedCount: 1 }),
    ).resolves.toEqual(succeeded);
    await expect(
      JobService.markSucceeded(12, { processedCount: 1 }),
    ).resolves.toEqual(succeeded);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(3);
  });

  it('keeps lifecycle transitions successful when notification publishing fails', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const running = createJob({ id: 34, status: JobStatus.RUNNING, stage: 'running' });
    const progressed = createJob({
      id: 34,
      status: JobStatus.RUNNING,
      progress: 60,
      stage: 'notified-progress',
    });
    mockPrisma.job.findUnique.mockResolvedValue(running);
    mockPrisma.job.update.mockResolvedValue(progressed);
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('notification unavailable'));

    await expect(
      JobService.updateProgress(34, 60, 'notified-progress'),
    ).resolves.toEqual(progressed);

    expect(mockPrisma.job.update).toHaveBeenCalledWith({
      where: { id: 34 },
      data: {
        progress: 60,
        stage: 'notified-progress',
      },
      select: expect.objectContaining({ id: true }),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 34,
        event: 'progress',
        operation: 'job.notify',
      }),
      'Job notification failed.',
    );
    warnSpy.mockRestore();
  });

  it('persists cancellation requests and cancellation finalization idempotently', async () => {
    const running = createJob({ id: 13, status: JobStatus.RUNNING, stage: 'running' });
    const cancelRequested = createJob({
      id: 13,
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: new Date(),
    });
    const cancelled = createJob({
      id: 13,
      status: JobStatus.CANCELLED,
      stage: 'cancelled',
      completedAt: new Date(),
    });
    mockPrisma.job.findUnique
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(cancelRequested)
      .mockResolvedValueOnce(cancelRequested)
      .mockResolvedValueOnce(cancelled);
    mockPrisma.job.update
      .mockResolvedValueOnce(cancelRequested)
      .mockResolvedValueOnce(cancelled);

    await expect(JobService.requestCancellation(13)).resolves.toEqual(cancelRequested);
    await expect(JobService.requestCancellation(13)).resolves.toEqual(cancelRequested);
    await expect(JobService.markCancelled(13)).resolves.toEqual(cancelled);
    await expect(JobService.markCancelled(13)).resolves.toEqual(cancelled);

    expect(mockPrisma.job.update).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid repeated state changes that would move backward', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(createJob({ status: JobStatus.SUCCEEDED }));

    await expect(JobService.markRunning(1)).rejects.toThrow(InvalidInputError);
    await expect(JobService.updateProgress(1, 5)).rejects.toThrow(InvalidInputError);
    await expect(JobService.heartbeat(1)).rejects.toThrow(InvalidInputError);
  });

  it('throws NotFoundError for missing jobs', async () => {
    mockPrisma.job.findUnique.mockResolvedValue(null);

    await expect(JobService.markRunning(404)).rejects.toThrow(new NotFoundError('Job not found'));
  });
});
