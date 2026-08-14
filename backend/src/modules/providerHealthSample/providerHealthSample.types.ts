import {
  LlmProviderConfigType,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
} from '@prisma/client';

export interface ProviderHealthSampleCreateInput {
  providerId: number;
  providerType: LlmProviderConfigType;
  operation: ProviderHealthSampleOperation;
  status: ProviderHealthSampleStatus;
  latencyMs?: number;
  modelCount?: number;
  errorCode?: string;
}
