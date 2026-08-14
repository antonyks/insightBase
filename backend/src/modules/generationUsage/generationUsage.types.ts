import { TokenUsage } from '../llm/llm.types';
import { GenerationUsageOutcome } from './generationUsage.model';

export interface GenerationUsageCreateInput {
  workspaceId: number;
  providerId: number;
  model: string;
  streaming: boolean;
  latencyMs?: number;
  usage?: TokenUsage;
  outcome: GenerationUsageOutcome;
  errorCode?: string;
}
