import {
  JobStatus,
  UserRole,
  UserStatus,
  WorkspaceMembershipRole,
  WorkspaceMembershipStatus,
  WorkspaceStatus,
  WorkspaceType,
} from '@prisma/client';
import { logger } from '../../config/logger';
import { LlmRuntimeService } from '../../modules/llm/llmRuntime.service';
import { SelectedJob, JobService, JobQueueTransport } from '../../modules/job';
import { WorkspaceProvisioningService } from '../../modules/workspace/workspaceProvisioning.service';
import {
  createProviderHealthSamplingJobHandler,
  enqueueProviderHealthSamplingJob,
  PROVIDER_HEALTH_SAMPLING_JOB_MAX_ATTEMPTS,
  PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
  PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
} from '../../modules/worker/providerHealthSamplingJob';
import { mockPrisma } from '../setup';

jest.mock('../../config/logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('../../modules/llm/llmRuntime.service', () => ({
  LlmRuntimeService: {
    listAvailableModels: jest.fn(),
  },
}));

const now = new Date('2026-01-01T00:00:00.000Z');

function createJob(overrides: Partial<SelectedJob> = {}): SelectedJob {
  return {
    id: 42,
    workspaceId: 9,
    type: PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
    status: JobStatus.QUEUED,
    progress: 0,
    stage: 'provider_health_sample_queued',
    payload: {},
    result: null,
    errorCode: null,
    sanitizedError: null,
    attempts: 0,
    maxAttempts: PROVIDER_HEALTH_SAMPLING_JOB_MAX_ATTEMPTS,
    queueMessageId: 'pgboss-42',
    createdByUserId: 3,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe('provider health sampling job', () => {
  const queueTransport: JobQueueTransport = {
    send: jest.fn(async () => 'pgboss-42'),
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockActiveAdminOwner() {
    mockPrisma.user.findFirst.mockResolvedValue({
      id: 3,
      name: 'Admin',
      email: 'admin@example.com',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      createdAt: now,
    });
    jest.spyOn(WorkspaceProvisioningService, 'ensurePersonalWorkspaceForUser')
      .mockResolvedValue({
        workspace: {
          id: 9,
          name: 'Personal Workspace',
          type: WorkspaceType.PERSONAL,
          status: WorkspaceStatus.ACTIVE,
          ownerUserId: 3,
          createdAt: now,
          updatedAt: now,
        },
        ownerMembership: {
          id: 11,
          workspaceId: 9,
          userId: 3,
          role: WorkspaceMembershipRole.OWNER,
          status: WorkspaceMembershipStatus.ACTIVE,
          createdAt: now,
          updatedAt: now,
        },
        workspaceCreated: false,
        workspaceUpdated: false,
        membershipCreated: false,
        membershipUpdated: false,
      });
  }

  it('enqueues one durable application job under the advisory lock', async () => {
    mockActiveAdminOwner();
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob').mockResolvedValue(createJob());

    await expect(enqueueProviderHealthSamplingJob(queueTransport)).resolves.toEqual({
      skipped: false,
      jobId: 42,
    });

    expect(enqueueSpy).toHaveBeenCalledWith({
      workspaceId: 9,
      createdByUserId: 3,
      type: PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
      queueName: PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
      payload: {},
      maxAttempts: PROVIDER_HEALTH_SAMPLING_JOB_MAX_ATTEMPTS,
      stage: 'provider_health_sample_queued',
    }, queueTransport);
  });

  it('skips enqueue when another worker holds the advisory lock', async () => {
    mockActiveAdminOwner();
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: false }]);
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob');

    await expect(enqueueProviderHealthSamplingJob(queueTransport)).resolves.toEqual({
      skipped: true,
      reason: 'lock_not_acquired',
    });

    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('skips enqueue when a provider health job is already non-terminal', async () => {
    mockActiveAdminOwner();
    mockPrisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    mockPrisma.job.findFirst.mockResolvedValue(createJob({ status: JobStatus.RUNNING }));
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob');

    await expect(enqueueProviderHealthSamplingJob(queueTransport)).resolves.toEqual({
      skipped: true,
      reason: 'job_already_pending',
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('skips enqueue without an active admin owner', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    const enqueueSpy = jest.spyOn(JobService, 'enqueueJob');

    await expect(enqueueProviderHealthSamplingJob(queueTransport)).resolves.toEqual({
      skipped: true,
      reason: 'missing_admin_owner',
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { jobType: PROVIDER_HEALTH_SAMPLING_JOB_TYPE },
      'Provider health sampling job enqueue skipped because no active admin owner exists.',
    );
  });

  it('samples providers through the runtime and returns sanitized aggregate counts', async () => {
    const updateProgressSpy = jest.spyOn(JobService, 'updateProgress').mockResolvedValue(createJob());
    jest.spyOn(LlmRuntimeService, 'listAvailableModels').mockResolvedValue({
      models: [],
      providers: [
        {
          providerId: '1',
          providerName: 'Local Provider',
          providerType: 'ollama',
          status: 'success',
          modelCount: 1,
          capabilities: {
            completion: true,
            streaming: true,
            reasoning: true,
            modelListing: true,
            modelPulling: true,
            embeddings: true,
            toolCalling: false,
            structuredOutput: false,
            tokenCounting: false,
          },
        },
        {
          providerId: '2',
          providerName: 'Remote Provider',
          providerType: 'openai-compatible',
          status: 'error',
          modelCount: 0,
          capabilities: {
            completion: true,
            streaming: true,
            reasoning: false,
            modelListing: true,
            modelPulling: false,
            embeddings: true,
            toolCalling: false,
            structuredOutput: false,
            tokenCounting: false,
          },
          errorMessage: 'secret-provider.example.com raw timeout',
          errorCode: 'PROVIDER_TIMEOUT',
        },
      ],
    });
    const heartbeat = jest.fn(async () => undefined);
    const checkpointCancellation = jest.fn(async () => undefined);

    const result = await createProviderHealthSamplingJobHandler()({
      job: createJob({ status: JobStatus.RUNNING }),
      payload: {},
      signal: new AbortController().signal,
      heartbeat,
      checkpointCancellation,
    });

    expect(result).toEqual({
      providers: 2,
      success: 1,
      error: 1,
      skipped: 0,
    });
    expect(JSON.stringify(result)).not.toContain('secret-provider');
    expect(JSON.stringify(result)).not.toContain('raw timeout');
    expect(updateProgressSpy).toHaveBeenNthCalledWith(1, 42, 10, 'provider_health_sampling_started');
    expect(updateProgressSpy).toHaveBeenNthCalledWith(2, 42, 90, 'provider_health_sampling_recorded');
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(checkpointCancellation).toHaveBeenCalledTimes(2);
  });
});
