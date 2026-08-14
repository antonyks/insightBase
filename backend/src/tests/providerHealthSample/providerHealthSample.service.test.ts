import {
  LlmProviderConfigType,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
} from '@prisma/client';
import { ProviderHealthSampleService } from '../../modules/providerHealthSample';
import { mockPrisma } from '../setup';

describe('ProviderHealthSampleService', () => {
  it('records request-time provider health samples without private config fields', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    mockPrisma.providerHealthSample.create.mockResolvedValue({
      id: 1,
      providerId: 7,
      providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
      operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
      status: ProviderHealthSampleStatus.SUCCESS,
      latencyMs: 124,
      modelCount: 3,
      errorCode: null,
      createdAt,
    });

    await expect(ProviderHealthSampleService.recordSample({
      providerId: 7,
      providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
      operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
      status: ProviderHealthSampleStatus.SUCCESS,
      latencyMs: 123.6,
      modelCount: 3,
    })).resolves.toMatchObject({
      providerId: 7,
      status: ProviderHealthSampleStatus.SUCCESS,
    });

    expect(mockPrisma.providerHealthSample.create).toHaveBeenCalledWith({
      data: {
        providerId: 7,
        providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
        operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
        status: ProviderHealthSampleStatus.SUCCESS,
        latencyMs: 124,
        modelCount: 3,
        errorCode: undefined,
      },
      select: expect.objectContaining({
        providerId: true,
        providerType: true,
        operation: true,
        status: true,
      }),
    });
    expect(JSON.stringify(mockPrisma.providerHealthSample.create.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(mockPrisma.providerHealthSample.create.mock.calls)).not.toContain('baseUrl');
    expect(JSON.stringify(mockPrisma.providerHealthSample.create.mock.calls)).not.toContain('errorMessage');
  });

  it('records provider test errors with stable error codes only', async () => {
    mockPrisma.providerHealthSample.create.mockResolvedValue({
      id: 2,
      providerId: 8,
      providerType: LlmProviderConfigType.OLLAMA,
      operation: ProviderHealthSampleOperation.PROVIDER_TEST,
      status: ProviderHealthSampleStatus.ERROR,
      latencyMs: 15,
      modelCount: null,
      errorCode: 'PROVIDER_TIMEOUT',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await ProviderHealthSampleService.recordSample({
      providerId: 8,
      providerType: LlmProviderConfigType.OLLAMA,
      operation: ProviderHealthSampleOperation.PROVIDER_TEST,
      status: ProviderHealthSampleStatus.ERROR,
      latencyMs: 15,
      errorCode: 'PROVIDER_TIMEOUT',
    });

    expect(mockPrisma.providerHealthSample.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerId: 8,
        operation: ProviderHealthSampleOperation.PROVIDER_TEST,
        status: ProviderHealthSampleStatus.ERROR,
        errorCode: 'PROVIDER_TIMEOUT',
      }),
      select: expect.any(Object),
    });
  });
});
