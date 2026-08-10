import { JobStatus } from '@prisma/client';
import { InvalidInputError } from '../../errors';
import {
  JobService,
  JobQueueTransport,
  PublicJob,
  SelectedJob,
} from '../../modules/job';
import {
  createValidationJobHandler,
  enqueueValidationJob,
  parseValidationJobMode,
  VALIDATION_JOB_CHECKSUM_ITERATIONS,
  VALIDATION_JOB_CHECKSUM_SEED,
  VALIDATION_JOB_QUEUE,
  VALIDATION_JOB_TYPE,
  ValidationChecksumInput,
  ValidationChecksumResult,
} from '../../modules/worker';
import { WorkerCpuTaskPool } from '../../modules/worker/workerTaskPool';

const now = new Date('2026-01-01T00:00:00.000Z');

function createJob(overrides: Partial<SelectedJob> = {}): SelectedJob {
  return {
    id: 12,
    workspaceId: 7,
    type: VALIDATION_JOB_TYPE,
    status: JobStatus.QUEUED,
    progress: 0,
    stage: 'validation_queued',
    payload: { mode: 'success' },
    result: null,
    errorCode: null,
    sanitizedError: null,
    attempts: 0,
    maxAttempts: 1,
    queueMessageId: 'queue-12',
    createdByUserId: 3,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function createPublicJob(overrides: Partial<PublicJob> = {}): PublicJob {
  const job = createJob(overrides as Partial<SelectedJob>);

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

describe('validation job', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses validation modes and rejects unsupported values', () => {
    expect(parseValidationJobMode(undefined)).toBe('success');
    expect(parseValidationJobMode('success')).toBe('success');
    expect(parseValidationJobMode('fail')).toBe('fail');
    expect(() => parseValidationJobMode('cancel')).toThrow(InvalidInputError);
  });

  it('enqueues a success validation job with sanitized public output', async () => {
    const queueTransport: JobQueueTransport = {
      send: jest.fn(async () => 'pgboss-12'),
    };
    const queuedJob = createJob();
    const publicJob = createPublicJob();
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob').mockResolvedValue(queuedJob);
    const getSpy = jest.spyOn(JobService, 'getJobInWorkspace').mockResolvedValue(publicJob);

    await expect(enqueueValidationJob({
      workspaceId: 7,
      createdByUserId: 3,
    }, queueTransport)).resolves.toBe(publicJob);

    expect(enqueueSpy).toHaveBeenCalledWith({
      workspaceId: 7,
      createdByUserId: 3,
      type: VALIDATION_JOB_TYPE,
      queueName: VALIDATION_JOB_QUEUE,
      payload: { mode: 'success' },
      maxAttempts: 1,
      stage: 'validation_queued',
    }, queueTransport);
    expect(getSpy).toHaveBeenCalledWith(12, 7);
  });

  it('enqueues a fail validation job with retry attempts configured', async () => {
    const queueTransport: JobQueueTransport = {
      send: jest.fn(async () => 'pgboss-13'),
    };
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob').mockResolvedValue(createJob({ id: 13 }));
    jest.spyOn(JobService, 'getJobInWorkspace').mockResolvedValue(createPublicJob({ id: 13 }));

    await enqueueValidationJob({
      workspaceId: 7,
      createdByUserId: 3,
      mode: 'fail',
    }, queueTransport);

    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      payload: { mode: 'fail' },
      maxAttempts: 2,
    }), queueTransport);
  });

  it('runs the checksum task through the CPU pool and returns a deterministic result', async () => {
    const runMock = jest.fn(async () => ({
      checksum: 'cec28d83362a96f97751981f0db822a82eb53043fb1abb75039ac76cfbee7483',
      iterations: VALIDATION_JOB_CHECKSUM_ITERATIONS,
      seedLength: VALIDATION_JOB_CHECKSUM_SEED.length,
    }));
    const cpuTaskPool: WorkerCpuTaskPool = {
      run: runMock as WorkerCpuTaskPool['run'],
      close: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
    };
    const updateProgressSpy = jest.spyOn(JobService, 'updateProgress').mockResolvedValue(createJob());
    const heartbeat = jest.fn(async () => undefined);
    const checkpointCancellation = jest.fn(async () => undefined);
    const signal = new AbortController().signal;

    await expect(createValidationJobHandler(cpuTaskPool)({
      job: createJob({ status: JobStatus.RUNNING }),
      payload: { mode: 'success' },
      signal,
      heartbeat,
      checkpointCancellation,
    })).resolves.toEqual({
      mode: 'success',
      checksum: 'cec28d83362a96f97751981f0db822a82eb53043fb1abb75039ac76cfbee7483',
      iterations: VALIDATION_JOB_CHECKSUM_ITERATIONS,
      seedLength: VALIDATION_JOB_CHECKSUM_SEED.length,
    });

    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({
      name: 'runValidationChecksum',
      input: {
        seed: VALIDATION_JOB_CHECKSUM_SEED,
        iterations: VALIDATION_JOB_CHECKSUM_ITERATIONS,
      } satisfies ValidationChecksumInput,
      signal,
    }));
    expect(updateProgressSpy).toHaveBeenNthCalledWith(1, 12, 25, 'validation_preparing');
    expect(updateProgressSpy).toHaveBeenNthCalledWith(2, 12, 75, 'validation_checksum_complete');
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(checkpointCancellation).toHaveBeenCalledTimes(2);
  });

  it('throws a deterministic error for fail-mode jobs after the checksum task', async () => {
    const runMock = jest.fn(async () => ({
      checksum: 'cec28d83362a96f97751981f0db822a82eb53043fb1abb75039ac76cfbee7483',
      iterations: VALIDATION_JOB_CHECKSUM_ITERATIONS,
      seedLength: VALIDATION_JOB_CHECKSUM_SEED.length,
    } satisfies ValidationChecksumResult));
    const cpuTaskPool: WorkerCpuTaskPool = {
      run: runMock as WorkerCpuTaskPool['run'],
      close: jest.fn(async () => undefined),
      destroy: jest.fn(async () => undefined),
    };
    jest.spyOn(JobService, 'updateProgress').mockResolvedValue(createJob());

    await expect(createValidationJobHandler(cpuTaskPool)({
      job: createJob({ status: JobStatus.RUNNING }),
      payload: { mode: 'fail' },
      signal: new AbortController().signal,
      heartbeat: jest.fn(async () => undefined),
      checkpointCancellation: jest.fn(async () => undefined),
    })).rejects.toThrow('Deterministic validation job forced failure.');
  });
});
