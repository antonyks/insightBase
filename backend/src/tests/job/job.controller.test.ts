import { JobStatus, WorkspaceStatus, WorkspaceType } from '@prisma/client';
import { JobController } from '../../modules/job/job.controller';
import { JobService } from '../../modules/job/job.service';
import { PublicJob } from '../../modules/job/job.types';
import { UserRole, UserStatus } from '../../modules/user/user.model';
import { createAuthenticatedMockRequest, createMockResponse } from '../testUtils';

function createJob(overrides: Partial<PublicJob> = {}): PublicJob {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 1,
    workspaceId: 25,
    type: 'validation.fixture',
    status: JobStatus.QUEUED,
    progress: 0,
    stage: 'queued',
    result: null,
    errorCode: null,
    sanitizedError: null,
    attempts: 0,
    maxAttempts: 1,
    createdByUserId: 7,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function createRequest(params = { jobId: '1' }) {
  return createAuthenticatedMockRequest({
    params,
    user: {
      id: 7,
      email: 'user@example.com',
      name: 'User',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    workspace: {
      id: 25,
      name: 'Personal Workspace',
      ownerUserId: 7,
      type: WorkspaceType.PERSONAL,
      status: WorkspaceStatus.ACTIVE,
    },
    workspaceActor: {
      userId: 7,
      role: UserRole.USER,
    },
  });
}

function createSseResponse() {
  const response = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    flushHeaders: jest.fn(),
    on: jest.fn(),
    writableEnded: false,
  };
  response.status.mockReturnValue(response);
  response.on.mockReturnValue(response);
  return response;
}

describe('JobController', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a workspace-scoped public job', async () => {
    const job = createJob({ result: { processedCount: 2 } });
    jest.spyOn(JobService, 'getJobInWorkspace').mockResolvedValue(job);
    const res = createMockResponse();

    await JobController.getJob(createRequest(), res);

    expect(JobService.getJobInWorkspace).toHaveBeenCalledWith(1, 25);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: job });
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('queueMessageId');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('payload');
  });

  it('cancels a workspace-scoped job idempotently through the service', async () => {
    const job = createJob({
      status: JobStatus.CANCEL_REQUESTED,
      stage: 'cancellation_requested',
      cancelRequestedAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    jest.spyOn(JobService, 'requestCancellationInWorkspace').mockResolvedValue(job);
    const res = createMockResponse();

    await JobController.cancelJob(createRequest(), res);

    expect(JobService.requestCancellationInWorkspace).toHaveBeenCalledWith(1, 25);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: job });
  });

  it('streams a snapshot followed by progress and terminal durable states', async () => {
    jest.useFakeTimers();
    const running = createJob({ status: JobStatus.RUNNING, stage: 'running' });
    const progressing = createJob({
      status: JobStatus.RUNNING,
      stage: 'halfway',
      progress: 50,
    });
    const succeeded = createJob({
      status: JobStatus.SUCCEEDED,
      stage: 'completed',
      progress: 100,
      completedAt: new Date('2026-01-01T00:00:03.000Z'),
    });
    jest.spyOn(JobService, 'getJobInWorkspace')
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(progressing)
      .mockResolvedValueOnce(succeeded);
    const req = createRequest();
    const res = createSseResponse();

    const streamPromise = JobController.streamJob(req, res as never);
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(1000);
    await streamPromise;

    const writtenChunks = res.write.mock.calls.map(([chunk]) => chunk);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(writtenChunks).toContain('event: snapshot\n');
    expect(writtenChunks).toContain('event: progress\n');
    expect(writtenChunks).toContain('event: succeeded\n');
    expect(res.end).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('emits heartbeat events while unchanged jobs remain active', async () => {
    jest.useFakeTimers();
    const running = createJob({ status: JobStatus.RUNNING, stage: 'running' });
    jest.spyOn(JobService, 'getJobInWorkspace').mockResolvedValue(running);
    const req = createRequest();
    const res = createSseResponse();
    res.write.mockImplementation((chunk: string) => {
      if (chunk === 'event: heartbeat\n') {
        res.writableEnded = true;
      }
      return true;
    });

    const streamPromise = JobController.streamJob(req, res as never);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15000);
    await streamPromise;

    const writtenChunks = res.write.mock.calls.map(([chunk]) => chunk);
    expect(writtenChunks).toContain('event: snapshot\n');
    expect(writtenChunks).toContain('event: heartbeat\n');
    expect(res.end).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
