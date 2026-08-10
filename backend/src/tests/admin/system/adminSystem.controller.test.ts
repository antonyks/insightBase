import { JobStatus } from '@prisma/client';
import { InvalidInputError } from '../../../errors';
import { AdminSystemController } from '../../../modules/admin/system/adminSystem.controller';
import { AdminSystemService } from '../../../modules/admin/system/adminSystem.service';
import { VALIDATION_JOB_TYPE } from '../../../modules/worker';
import { createAuthenticatedMockRequest, createMockResponse } from '../../testUtils';

jest.mock('../../../modules/llm/llmRuntime.service', () => ({
  LlmRuntimeService: {
    listAvailableModels: jest.fn(),
  },
}));

jest.mock('../../../modules/job/jobQueue.client', () => ({
  getJobQueueTransport: jest.fn(),
}));

describe('AdminSystemController validation jobs', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a validation job in the authenticated admin workspace', async () => {
    const publicJob = {
      id: 44,
      workspaceId: 8,
      type: VALIDATION_JOB_TYPE,
      status: JobStatus.QUEUED,
      progress: 0,
      stage: 'validation_queued',
      result: null,
      errorCode: null,
      sanitizedError: null,
      attempts: 0,
      maxAttempts: 1,
      createdByUserId: 3,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
    };
    const enqueueSpy = jest
      .spyOn(AdminSystemService, 'enqueueValidationJob')
      .mockResolvedValue(publicJob);
    const res = createMockResponse();

    await AdminSystemController.createValidationJob(
      createAuthenticatedMockRequest({
        user: { id: 3 } as never,
        workspace: { id: 8 } as never,
        body: { mode: 'fail' },
      }),
      res,
    );

    expect(enqueueSpy).toHaveBeenCalledWith({
      workspaceId: 8,
      createdByUserId: 3,
      mode: 'fail',
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ data: publicJob });
  });

  it('rejects missing workspace context', async () => {
    await expect(AdminSystemController.createValidationJob(
      createAuthenticatedMockRequest({ user: { id: 3 } as never }),
      createMockResponse(),
    )).rejects.toThrow(InvalidInputError);
  });
});
