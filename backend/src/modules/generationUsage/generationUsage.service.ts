import { GenerationUsageRepository } from './generationUsage.repository';
import {
  GenerationUsageOutcome,
  GenerationUsageTokenCountSource,
  SelectedGenerationUsage,
} from './generationUsage.model';
import { GenerationUsageCreateInput } from './generationUsage.types';

function normalizeLatencyMs(latencyMs: number | undefined): number | undefined {
  if (latencyMs === undefined) return undefined;
  if (!Number.isFinite(latencyMs)) return undefined;
  return Math.max(0, Math.round(latencyMs));
}

export const GenerationUsageService = {
  async recordGeneration(input: GenerationUsageCreateInput): Promise<SelectedGenerationUsage> {
    const usage = input.usage;

    return GenerationUsageRepository.create({
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      model: input.model,
      streaming: input.streaming,
      latencyMs: normalizeLatencyMs(input.latencyMs),
      inputTokens: usage?.promptTokens,
      outputTokens: usage?.completionTokens,
      totalTokens: usage?.totalTokens,
      tokenCountSource: usage
        ? GenerationUsageTokenCountSource.PROVIDER_REPORTED
        : GenerationUsageTokenCountSource.UNKNOWN,
      outcome: input.outcome,
      errorCode: input.outcome === GenerationUsageOutcome.SUCCEEDED ? undefined : input.errorCode,
    });
  },
};
