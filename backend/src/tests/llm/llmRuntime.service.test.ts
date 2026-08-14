import fetch, { Response } from 'node-fetch';
import {
  LlmProviderConfigType,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
} from '@prisma/client';
import { describe, expect, it, jest, afterEach, beforeEach } from '@jest/globals';
import { LlmRuntimeService } from '../../modules/llm/llmRuntime.service';
import { ILlmProvider } from '../../modules/llm/llm.interface';
import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmEmbeddingRequest,
  LlmEmbeddingResponse,
  LlmProviderCapabilities,
  LlmProviderConfig,
  LlmProviderListedModel,
  LlmStreamChunk,
} from '../../modules/llm/llm.types';
import { SelectedLlmProviderConfig } from '../../modules/llm/llmProviderConfig.model';
import { LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE } from '../../modules/llm/llm.capabilities';
import { mockPrisma } from '../setup';

jest.mock('node-fetch', () => jest.fn());

const TEST_MODEL_ID = process.env.OLLAMA_MODEL as string;
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

const UNSUPPORTED_EMBEDDING_CAPABILITIES: LlmProviderCapabilities = {
  completion: true,
  streaming: true,
  reasoning: false,
  modelListing: true,
  modelPulling: false,
  embeddings: false,
  toolCalling: false,
  structuredOutput: false,
  tokenCounting: false,
};

function createProviderConfig(overrides: Partial<SelectedLlmProviderConfig> = {}): SelectedLlmProviderConfig {
  return {
    id: 1,
    name: 'Provider',
    type: 'OPENAI_COMPATIBLE',
    baseUrl: 'https://api.example.com/v1',
    enabled: true,
    defaultModel: TEST_MODEL_ID,
    timeoutMs: 5000,
    generationDefaults: {},
    extraHeaders: {},
    apiKey: 'secret-key',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createRuntimeProvider(
  embed: jest.Mock<(request: LlmEmbeddingRequest) => Promise<LlmEmbeddingResponse>>,
): ILlmProvider {
  const config: LlmProviderConfig = {
    id: '1',
    name: 'Provider',
    type: 'openai-compatible',
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    defaultModel: TEST_MODEL_ID,
  };

  return {
    id: config.id,
    type: config.type,
    isEnabled: config.enabled,
    capabilities: UNSUPPORTED_EMBEDDING_CAPABILITIES,
    config,
    initialise: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    complete: jest.fn<(request: LlmCompletionRequest) => Promise<LlmCompletionResponse>>(),
    streamComplete: jest.fn<(request: LlmCompletionRequest) => AsyncIterable<LlmStreamChunk>>(),
    embed,
    listModels: jest.fn<() => Promise<LlmProviderListedModel[]>>().mockResolvedValue([]),
  };
}

function mockModelListResponse(modelIds = [TEST_MODEL_ID]): Response {
  return {
    ok: true,
    status: 200,
    json: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      object: 'list',
      data: modelIds.map((id) => ({ id, object: 'model' })),
    }),
    text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
  } as unknown as Response;
}

describe('LlmRuntimeService embeddings', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails unsupported embeddings through the capability guard before invoking the adapter', async () => {
    const embed = jest.fn<(request: LlmEmbeddingRequest) => Promise<LlmEmbeddingResponse>>();
    jest.spyOn(LlmRuntimeService, 'createProvider').mockReturnValue(createRuntimeProvider(embed));
    mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProviderConfig());

    await expect(LlmRuntimeService.embedWithProvider({
      providerId: 1,
      request: {
        model: TEST_MODEL_ID,
        input: 'Private input',
      },
    })).rejects.toMatchObject({
      code: LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE,
      message: 'Provider type openai-compatible does not support embeddings.',
    });

    expect(embed).not.toHaveBeenCalled();
  });

  it('records provider health samples for single-provider model registry requests', async () => {
    mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProviderConfig({
      id: 7,
      type: LlmProviderConfigType.OPENAI_COMPATIBLE,
    }));
    mockPrisma.providerHealthSample.create.mockResolvedValue({
      id: 1,
      providerId: 7,
      providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
      operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
      status: ProviderHealthSampleStatus.SUCCESS,
      latencyMs: 3,
      modelCount: 2,
      errorCode: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mockedFetch.mockResolvedValue(mockModelListResponse([
      TEST_MODEL_ID,
      `${TEST_MODEL_ID}-secondary`,
    ]));

    await expect(LlmRuntimeService.listProviderModels(7)).resolves.toMatchObject({
      providers: [
        {
          providerId: '7',
          status: 'success',
          modelCount: 2,
        },
      ],
    });

    expect(mockPrisma.providerHealthSample.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerId: 7,
        providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
        operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
        status: ProviderHealthSampleStatus.SUCCESS,
        modelCount: 2,
        errorCode: undefined,
      }),
      select: expect.any(Object),
    });
  });

  it('records provider health samples for explicit provider tests', async () => {
    mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProviderConfig({
      id: 8,
      type: LlmProviderConfigType.OPENAI_COMPATIBLE,
    }));
    mockPrisma.providerHealthSample.create.mockResolvedValue({
      id: 2,
      providerId: 8,
      providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
      operation: ProviderHealthSampleOperation.PROVIDER_TEST,
      status: ProviderHealthSampleStatus.SUCCESS,
      latencyMs: 5,
      modelCount: null,
      errorCode: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mockedFetch.mockResolvedValue(mockModelListResponse());

    await expect(LlmRuntimeService.testProvider(8)).resolves.toMatchObject({
      providerId: '8',
      status: 'success',
    });

    expect(mockPrisma.providerHealthSample.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerId: 8,
        providerType: LlmProviderConfigType.OPENAI_COMPATIBLE,
        operation: ProviderHealthSampleOperation.PROVIDER_TEST,
        status: ProviderHealthSampleStatus.SUCCESS,
        errorCode: undefined,
      }),
      select: expect.any(Object),
    });
  });
});
