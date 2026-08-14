import type { UserRole } from "../../types/user";

export type LlmProviderType = "ollama" | "openai-compatible";
export type UserStatus = "ACTIVE" | "BANNED" | "DELETED";
export type LlmProviderModelListStatus = "success" | "error" | "skipped";
export type LlmModelCapabilityStatus = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

export interface GenerationDefaults {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface LlmProviderCapabilities {
  completion: boolean;
  streaming: boolean;
  reasoning: boolean;
  modelListing: boolean;
  modelPulling: boolean;
  embeddings: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  tokenCounting: boolean;
}

export interface LlmModelCapabilities {
  completion: LlmModelCapabilityStatus;
  streaming: LlmModelCapabilityStatus;
  reasoning: LlmModelCapabilityStatus;
  embeddings: LlmModelCapabilityStatus;
  toolCalling: LlmModelCapabilityStatus;
  structuredOutput: LlmModelCapabilityStatus;
  tokenCounting: LlmModelCapabilityStatus;
}

export interface SanitizedLlmProviderConfig {
  id: number;
  name: string;
  type: LlmProviderType;
  baseUrl: string;
  enabled: boolean;
  defaultModel: string;
  timeoutMs: number | null;
  generationDefaults: GenerationDefaults;
  capabilities: LlmProviderCapabilities;
  extraHeaders: Record<string, string>;
  hasApiKey: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderConfigInput {
  name: string;
  type: LlmProviderType;
  baseUrl: string;
  enabled?: boolean;
  defaultModel: string;
  timeoutMs?: number | null;
  generationDefaults?: GenerationDefaults | null;
  extraHeaders?: Record<string, string>;
  apiKey?: string | null;
}

export interface LlmListedModel {
  providerId: string;
  providerName: string;
  providerType: LlmProviderType;
  modelId: string;
  modelName: string;
  capabilities: LlmModelCapabilities;
}

export interface LlmProviderModelListResult {
  providerId: string;
  providerName: string;
  providerType: LlmProviderType;
  generationDefaults?: GenerationDefaults;
  status: LlmProviderModelListStatus;
  modelCount: number;
  capabilities: LlmProviderCapabilities;
  errorMessage?: string;
}

export interface LlmProviderOperationResult {
  providerId: string;
  providerName: string;
  providerType: LlmProviderType;
  status: LlmProviderModelListStatus;
  errorMessage?: string;
}

export interface LlmModelListResult {
  models: LlmListedModel[];
  providers: LlmProviderModelListResult[];
}

export interface AdminUserPreview {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export type AdminUser = AdminUserPreview;

export interface AdminUserListParams {
  name?: string;
  skip?: number;
  take?: number;
}

export interface AdminUserCreateInput {
  name: string;
  email: string;
  password: string;
}

export interface AdminUserUpdateInput {
  name: string;
  email: string;
}

export interface AdminAnalyticsSummary {
  period: {
    from: string | null;
    to: string | null;
  };
  providers: {
    total: number;
    active: number;
    disabled: number;
  };
  users: {
    total: number;
    active: number;
    banned: number;
    deleted: number;
    review: number;
  };
  generation: {
    total: number;
    succeeded: number;
    failed: number;
    aborted: number;
    successRate: number;
    failureRate: number;
    abortRate: number;
    averageLatencyMs: number | null;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  jobs: {
    total: number;
    current: {
      queued: number;
      running: number;
      cancelRequested: number;
      cancelled: number;
      succeeded: number;
      failed: number;
    };
    finalized: {
      total: number;
      succeeded: number;
      failed: number;
      cancelled: number;
    };
    averageQueueWaitMs: number | null;
    averageExecutionDurationMs: number | null;
    averageAttempts: number | null;
  };
  providerHealth: {
    total: number;
    success: number;
    error: number;
    skipped: number;
    errorRate: number;
    averageLatencyMs: number | null;
    latestSampleAt: string | null;
  };
}

export interface AdminSystemStatus {
  backend: {
    status: "online";
  };
  database: {
    status: "online" | "error";
    errorMessage?: string;
  };
  inference: {
    status: "online" | "review" | "offline";
    providers: number;
    errors: number;
    skipped: number;
  };
}
