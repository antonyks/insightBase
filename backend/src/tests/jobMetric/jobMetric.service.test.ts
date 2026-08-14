import { JobMetricOutcome, Prisma } from '@prisma/client';
import { JobMetricService } from '../../modules/jobMetric';
import { mockPrisma } from '../setup';

describe('JobMetricService', () => {
  it('records one sanitized finalization metric for a job', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    mockPrisma.jobMetric.create.mockResolvedValue({
      id: 1,
      jobId: 11,
      workspaceId: 22,
      jobType: 'validation.fixture',
      outcome: JobMetricOutcome.SUCCEEDED,
      attempts: 2,
      queueWaitMs: 1000,
      executionDurationMs: 2500,
      errorCode: null,
      createdAt,
    });

    await expect(JobMetricService.recordFinalizedJob({
      jobId: 11,
      workspaceId: 22,
      jobType: 'validation.fixture',
      outcome: JobMetricOutcome.SUCCEEDED,
      attempts: 2,
      queueWaitMs: 1000.4,
      executionDurationMs: 2499.6,
    })).resolves.toMatchObject({
      jobId: 11,
      outcome: JobMetricOutcome.SUCCEEDED,
    });

    expect(mockPrisma.jobMetric.create).toHaveBeenCalledWith({
      data: {
        jobId: 11,
        workspaceId: 22,
        jobType: 'validation.fixture',
        outcome: JobMetricOutcome.SUCCEEDED,
        attempts: 2,
        queueWaitMs: 1000,
        executionDurationMs: 2500,
        errorCode: undefined,
      },
      select: expect.objectContaining({
        jobId: true,
        workspaceId: true,
        outcome: true,
      }),
    });
    expect(JSON.stringify(mockPrisma.jobMetric.create.mock.calls)).not.toContain('payload');
    expect(JSON.stringify(mockPrisma.jobMetric.create.mock.calls)).not.toContain('result');
  });

  it('treats duplicate job metrics as idempotent terminal finalization', async () => {
    mockPrisma.jobMetric.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(JobMetricService.recordFinalizedJob({
      jobId: 11,
      workspaceId: 22,
      jobType: 'validation.fixture',
      outcome: JobMetricOutcome.FAILED,
      attempts: 1,
      errorCode: 'JOB_HANDLER_FAILED',
    })).resolves.toBeNull();
  });
});
