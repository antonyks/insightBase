import { prisma } from '../../config/database';
import { GenerationUsage, GenerationUsageOutcome, GenerationUsageTokenCountSource, Prisma } from '@prisma/client';

export { GenerationUsage, GenerationUsageOutcome, GenerationUsageTokenCountSource };

export const GenerationUsageSelectFields = {
  id: true,
  workspaceId: true,
  providerId: true,
  model: true,
  streaming: true,
  latencyMs: true,
  inputTokens: true,
  outputTokens: true,
  totalTokens: true,
  tokenCountSource: true,
  outcome: true,
  errorCode: true,
  createdAt: true,
} as const;

export type SelectedGenerationUsage = Prisma.GenerationUsageGetPayload<{
  select: typeof GenerationUsageSelectFields;
}>;

export const GenerationUsageModel = prisma.generationUsage;
