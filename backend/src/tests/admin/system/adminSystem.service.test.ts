import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  GenerationUsageOutcome,
  JobMetricOutcome,
  JobStatus,
  ProviderHealthSampleStatus,
} from '@prisma/client';
import { logger } from '../../../config/logger';
import { AdminSystemService } from '../../../modules/admin/system/adminSystem.service';
import { LlmRuntimeService } from '../../../modules/llm/llmRuntime.service';
import { mockPrisma } from '../../setup';

jest.mock('../../../config/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('../../../modules/llm/llmRuntime.service', () => ({
  LlmRuntimeService: {
    listAvailableModels: jest.fn(),
  },
}));

jest.mock('../../../modules/job/jobQueue.client', () => ({
  getJobQueueTransport: jest.fn(),
}));

const providerCapabilities = {
  completion: false,
  streaming: false,
  reasoning: false,
  modelListing: false,
  modelPulling: false,
  embeddings: false,
  toolCalling: false,
  structuredOutput: false,
  tokenCounting: false,
};

describe('AdminSystemService', () => {
  const mockListAvailableModels = jest.mocked(LlmRuntimeService.listAvailableModels);
  const mockLoggerError = jest.mocked(logger.error);

  afterEach(() => {
    mockListAvailableModels.mockReset();
    mockLoggerError.mockReset();
    jest.restoreAllMocks();
  });

  describe('getAnalyticsSummary', () => {
    function mockEmptyMetricAggregates() {
      mockPrisma.generationUsage.count.mockResolvedValue(0);
      mockPrisma.generationUsage.groupBy.mockResolvedValue([]);
      mockPrisma.generationUsage.aggregate.mockResolvedValue({
        _avg: { latencyMs: null },
        _sum: { inputTokens: null, outputTokens: null, totalTokens: null },
      });
      mockPrisma.job.count.mockResolvedValue(0);
      mockPrisma.job.groupBy.mockResolvedValue([]);
      mockPrisma.jobMetric.count.mockResolvedValue(0);
      mockPrisma.jobMetric.groupBy.mockResolvedValue([]);
      mockPrisma.jobMetric.aggregate.mockResolvedValue({
        _avg: { queueWaitMs: null, executionDurationMs: null, attempts: null },
      });
      mockPrisma.providerHealthSample.count.mockResolvedValue(0);
      mockPrisma.providerHealthSample.groupBy.mockResolvedValue([]);
      mockPrisma.providerHealthSample.aggregate.mockResolvedValue({
        _avg: { latencyMs: null },
      });
      mockPrisma.providerHealthSample.findFirst.mockResolvedValue(null);
    }

    it('returns provider and user counts with empty aggregate defaults without listing upstream models', async () => {
      mockPrisma.llmProviderConfig.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockPrisma.user.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockEmptyMetricAggregates();

      const result = await AdminSystemService.getAnalyticsSummary();

      expect(result).toEqual({
        period: {
          from: null,
          to: null,
        },
        providers: {
          total: 3,
          active: 2,
          disabled: 1,
        },
        users: {
          total: 10,
          active: 7,
          banned: 2,
          deleted: 1,
          review: 3,
        },
        generation: {
          total: 0,
          succeeded: 0,
          failed: 0,
          aborted: 0,
          successRate: 0,
          failureRate: 0,
          abortRate: 0,
          averageLatencyMs: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        jobs: {
          total: 0,
          current: {
            queued: 0,
            running: 0,
            cancelRequested: 0,
            cancelled: 0,
            succeeded: 0,
            failed: 0,
          },
          finalized: {
            total: 0,
            succeeded: 0,
            failed: 0,
            cancelled: 0,
          },
          averageQueueWaitMs: null,
          averageExecutionDurationMs: null,
          averageAttempts: null,
        },
        providerHealth: {
          total: 0,
          success: 0,
          error: 0,
          skipped: 0,
          errorRate: 0,
          averageLatencyMs: null,
          latestSampleAt: null,
        },
      });
      expect(mockPrisma.llmProviderConfig.count).toHaveBeenCalledTimes(3);
      expect(mockPrisma.user.count).toHaveBeenCalledTimes(4);
    });

    it('returns populated system-wide operational aggregates within an optional period', async () => {
      const from = '2026-08-14T00:00:00.000Z';
      const to = '2026-08-15T00:00:00.000Z';
      const createdAtWhere = {
        createdAt: {
          gte: new Date(from),
          lt: new Date(to),
        },
      };
      mockPrisma.llmProviderConfig.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockPrisma.user.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockPrisma.generationUsage.count.mockResolvedValue(10);
      mockPrisma.generationUsage.groupBy.mockResolvedValue([
        { outcome: GenerationUsageOutcome.SUCCEEDED, _count: { _all: 7 } },
        { outcome: GenerationUsageOutcome.FAILED, _count: { _all: 2 } },
        { outcome: GenerationUsageOutcome.ABORTED, _count: { _all: 1 } },
      ]);
      mockPrisma.generationUsage.aggregate.mockResolvedValue({
        _avg: { latencyMs: 123.4 },
        _sum: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      mockPrisma.job.count.mockResolvedValue(12);
      mockPrisma.job.groupBy.mockResolvedValue([
        { status: JobStatus.QUEUED, _count: { _all: 2 } },
        { status: JobStatus.RUNNING, _count: { _all: 1 } },
        { status: JobStatus.SUCCEEDED, _count: { _all: 6 } },
        { status: JobStatus.FAILED, _count: { _all: 3 } },
      ]);
      mockPrisma.jobMetric.count.mockResolvedValue(9);
      mockPrisma.jobMetric.groupBy.mockResolvedValue([
        { outcome: JobMetricOutcome.SUCCEEDED, _count: { _all: 6 } },
        { outcome: JobMetricOutcome.FAILED, _count: { _all: 2 } },
        { outcome: JobMetricOutcome.CANCELLED, _count: { _all: 1 } },
      ]);
      mockPrisma.jobMetric.aggregate.mockResolvedValue({
        _avg: { queueWaitMs: 10.4, executionDurationMs: 80.6, attempts: 1.2 },
      });
      mockPrisma.providerHealthSample.count.mockResolvedValue(8);
      mockPrisma.providerHealthSample.groupBy.mockResolvedValue([
        { status: ProviderHealthSampleStatus.SUCCESS, _count: { _all: 5 } },
        { status: ProviderHealthSampleStatus.ERROR, _count: { _all: 2 } },
        { status: ProviderHealthSampleStatus.SKIPPED, _count: { _all: 1 } },
      ]);
      mockPrisma.providerHealthSample.aggregate.mockResolvedValue({
        _avg: { latencyMs: 22.4 },
      });
      mockPrisma.providerHealthSample.findFirst.mockResolvedValue({
        createdAt: new Date('2026-08-14T12:00:00.000Z'),
      });

      const result = await AdminSystemService.getAnalyticsSummary({ from, to });

      expect(result).toMatchObject({
        period: { from, to },
        generation: {
          total: 10,
          succeeded: 7,
          failed: 2,
          aborted: 1,
          successRate: 0.7,
          failureRate: 0.2,
          abortRate: 0.1,
          averageLatencyMs: 123,
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        jobs: {
          total: 12,
          current: {
            queued: 2,
            running: 1,
            cancelRequested: 0,
            cancelled: 0,
            succeeded: 6,
            failed: 3,
          },
          finalized: {
            total: 9,
            succeeded: 6,
            failed: 2,
            cancelled: 1,
          },
          averageQueueWaitMs: 10,
          averageExecutionDurationMs: 81,
          averageAttempts: 1,
        },
        providerHealth: {
          total: 8,
          success: 5,
          error: 2,
          skipped: 1,
          errorRate: 0.25,
          averageLatencyMs: 22,
          latestSampleAt: '2026-08-14T12:00:00.000Z',
        },
      });
      expect(mockPrisma.generationUsage.count).toHaveBeenCalledWith({ where: createdAtWhere });
      expect(mockPrisma.jobMetric.count).toHaveBeenCalledWith({ where: createdAtWhere });
      expect(mockPrisma.providerHealthSample.count).toHaveBeenCalledWith({ where: createdAtWhere });
      expect(mockPrisma.job.count).toHaveBeenCalledWith();
    });

    it('rejects invalid analytics periods', async () => {
      await expect(
        AdminSystemService.getAnalyticsSummary({ from: 'not-a-date' }),
      ).rejects.toMatchObject({ code: 'ANALYTICS_PERIOD_INVALID' });
      await expect(
        AdminSystemService.getAnalyticsSummary({
          from: '2026-08-15T00:00:00.000Z',
          to: '2026-08-14T00:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'ANALYTICS_PERIOD_INVALID' });

      expect(mockPrisma.llmProviderConfig.count).not.toHaveBeenCalled();
    });
  });

  describe('getSystemStatus', () => {
    function mockNoRecentProviderHealthSamples() {
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([
        { id: 1 },
        { id: 2 },
      ] as never);
      mockPrisma.providerHealthSample.findMany.mockResolvedValue([]);
    }

    it('returns online database and inference status when enabled providers exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockNoRecentProviderHealthSamples();
      mockListAvailableModels.mockResolvedValue({
        models: [],
        providers: [
          {
            providerId: '1',
            providerName: 'Local Ollama',
            providerType: 'ollama',
            status: 'success',
            modelCount: 2,
            capabilities: providerCapabilities,
          },
          {
            providerId: '2',
            providerName: 'Disabled Provider',
            providerType: 'ollama',
            status: 'skipped',
            modelCount: 0,
            capabilities: providerCapabilities,
          },
        ],
      });

      const result = await AdminSystemService.getSystemStatus();

      expect(result).toEqual({
        backend: { status: 'online' },
        database: { status: 'online' },
        inference: {
          status: 'online',
          providers: 2,
          errors: 0,
          skipped: 1,
        },
      });
    });

    it('uses recent provider health samples before live model registry checks', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ] as never);
      mockPrisma.providerHealthSample.findMany.mockResolvedValue([
        {
          providerId: 1,
          status: ProviderHealthSampleStatus.SUCCESS,
        },
        {
          providerId: 2,
          status: ProviderHealthSampleStatus.ERROR,
        },
        {
          providerId: 2,
          status: ProviderHealthSampleStatus.SUCCESS,
        },
        {
          providerId: 3,
          status: ProviderHealthSampleStatus.SKIPPED,
        },
      ] as never);

      const result = await AdminSystemService.getSystemStatus();

      expect(result.inference).toEqual({
        status: 'review',
        providers: 3,
        errors: 1,
        skipped: 1,
      });
      expect(mockListAvailableModels).not.toHaveBeenCalled();
    });

    it('returns database errors without throwing the status endpoint', async () => {
      mockPrisma.$queryRaw.mockRejectedValue(new Error('database unavailable'));

      const result = await AdminSystemService.getSystemStatus();

      expect(result.database).toEqual({
        status: 'error',
        errorMessage: 'Database health check failed',
      });
      expect(result.inference).toEqual({
        status: 'offline',
        providers: 0,
        errors: 0,
        skipped: 0,
      });
      expect(LlmRuntimeService.listAvailableModels).not.toHaveBeenCalled();
      expect(mockPrisma.llmProviderConfig.count).not.toHaveBeenCalled();
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
    });

    it('returns review inference status when providers report errors', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockNoRecentProviderHealthSamples();
      mockListAvailableModels.mockResolvedValue({
        models: [],
        providers: [
          {
            providerId: '1',
            providerName: 'Local Ollama',
            providerType: 'ollama',
            status: 'success',
            modelCount: 2,
            capabilities: providerCapabilities,
          },
          {
            providerId: '2',
            providerName: 'Remote Provider',
            providerType: 'ollama',
            status: 'error',
            modelCount: 0,
            capabilities: providerCapabilities,
            errorMessage: 'provider offline',
          },
        ],
      });

      const result = await AdminSystemService.getSystemStatus();

      expect(result.inference).toEqual({
        status: 'review',
        providers: 2,
        errors: 1,
        skipped: 0,
      });
    });

    it('returns offline inference status when no providers succeed', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockNoRecentProviderHealthSamples();
      mockListAvailableModels.mockResolvedValue({
        models: [],
        providers: [
          {
            providerId: '1',
            providerName: 'Disabled Provider',
            providerType: 'ollama',
            status: 'skipped',
            modelCount: 0,
            capabilities: providerCapabilities,
          },
        ],
      });

      const result = await AdminSystemService.getSystemStatus();

      expect(result.inference).toEqual({
        status: 'offline',
        providers: 1,
        errors: 0,
        skipped: 1,
      });
    });
  });
});
