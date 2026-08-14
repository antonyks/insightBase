import { prisma } from '../../config/database';
import {
  Prisma,
  ProviderHealthSample,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
} from '@prisma/client';

export { ProviderHealthSample, ProviderHealthSampleOperation, ProviderHealthSampleStatus };

export const ProviderHealthSampleSelectFields = {
  id: true,
  providerId: true,
  providerType: true,
  operation: true,
  status: true,
  latencyMs: true,
  modelCount: true,
  errorCode: true,
  createdAt: true,
} as const;

export type SelectedProviderHealthSample = Prisma.ProviderHealthSampleGetPayload<{
  select: typeof ProviderHealthSampleSelectFields;
}>;

export const ProviderHealthSampleModel = prisma.providerHealthSample;
