import { GenerationUsageSelectFields } from '../../modules/generationUsage/generationUsage.model';
import { GenerationUsageService } from '../../modules/generationUsage/generationUsage.service';
import { GenerationUsageOutcome, GenerationUsageTokenCountSource } from '../../modules/generationUsage';
import { mockPrisma } from '../setup';

describe('GenerationUsageService', () => {
  it('records provider-reported token usage without content-bearing fields', async () => {
    const createdAt = new Date('2026-08-14T00:00:00.000Z');
    mockPrisma.generationUsage.create.mockResolvedValue({
      id: 1,
      workspaceId: 25,
      providerId: 3,
      model: 'test-model',
      streaming: false,
      latencyMs: 13,
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
      outcome: GenerationUsageOutcome.SUCCEEDED,
      errorCode: null,
      createdAt,
    });

    await GenerationUsageService.recordGeneration({
      workspaceId: 25,
      providerId: 3,
      model: 'test-model',
      streaming: false,
      latencyMs: 12.7,
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      outcome: GenerationUsageOutcome.SUCCEEDED,
      errorCode: 'SHOULD_NOT_BE_STORED_ON_SUCCESS',
    });

    expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 25,
        providerId: 3,
        model: 'test-model',
        streaming: false,
        latencyMs: 13,
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
        outcome: GenerationUsageOutcome.SUCCEEDED,
        errorCode: undefined,
      },
      select: GenerationUsageSelectFields,
    });
    const createArg = mockPrisma.generationUsage.create.mock.calls[0][0] as { data: unknown };
    expect(JSON.stringify(createArg.data)).not.toContain('prompt');
    expect(JSON.stringify(createArg.data)).not.toContain('assistant');
    expect(JSON.stringify(createArg.data)).not.toContain('secret');
  });

  it('records missing token usage as unknown with null token counts', async () => {
    mockPrisma.generationUsage.create.mockResolvedValue({
      id: 2,
      workspaceId: 25,
      providerId: 3,
      model: 'test-model',
      streaming: true,
      latencyMs: 9,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
      outcome: GenerationUsageOutcome.FAILED,
      errorCode: 'UPSTREAM_STREAM_ERROR',
      createdAt: new Date('2026-08-14T00:00:00.000Z'),
    });

    await GenerationUsageService.recordGeneration({
      workspaceId: 25,
      providerId: 3,
      model: 'test-model',
      streaming: true,
      latencyMs: 9,
      outcome: GenerationUsageOutcome.FAILED,
      errorCode: 'UPSTREAM_STREAM_ERROR',
    });

    expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 25,
        providerId: 3,
        model: 'test-model',
        streaming: true,
        latencyMs: 9,
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
        outcome: GenerationUsageOutcome.FAILED,
        errorCode: 'UPSTREAM_STREAM_ERROR',
      },
      select: GenerationUsageSelectFields,
    });
  });
});
