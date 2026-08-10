import { afterEach, describe, expect, it, jest } from '@jest/globals';
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
    it('returns provider and user counts without listing upstream models', async () => {
      mockPrisma.llmProviderConfig.count
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);
      mockPrisma.user.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1);

      const result = await AdminSystemService.getAnalyticsSummary();

      expect(result).toEqual({
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
      });
      expect(mockPrisma.llmProviderConfig.count).toHaveBeenCalledTimes(3);
      expect(mockPrisma.user.count).toHaveBeenCalledTimes(4);
    });
  });

  describe('getSystemStatus', () => {
    it('returns online database and inference status when enabled providers exist', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
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
