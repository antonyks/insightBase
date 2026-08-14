import { ENV } from '../../config/env';
import { logger } from '../../config/logger';
import { InvalidInputError, NotFoundError } from '../../errors';
import { ILlmProvider } from './llm.interface';
import { LlmProviderConfigRepository } from './llmProviderConfig.repository';
import { fromDbProviderType, toDbProviderType } from './llmProviderConfig.types';
import { SelectedLlmProviderConfig } from './llmProviderConfig.model';
import { LlmRegistryService } from './llm.service';
import {
  ensureLlmProviderCapability,
  LlmProviderCapability,
} from './llm.capabilities';
import {
  LlmModelListResult,
  LlmEmbeddingRequest,
  LlmEmbeddingResponse,
  LlmGenerationDefaults,
  LlmProviderConfig,
  LlmProviderOperationResult,
  LlmStreamChunk,
  LlmProviderType,
  UNSUPPORTED_LLM_PROVIDER_CAPABILITIES,
  LlmProviderModelListResult,
} from './llm.types';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAiCompatibleProvider } from './providers/openaiCompatible.provider';
import { getLlmErrorCode, logLlmEvent } from './llm.logging';
import {
  ProviderHealthSampleOperation,
  ProviderHealthSampleService,
  ProviderHealthSampleStatus,
} from '../providerHealthSample';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown provider error';
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  return undefined;
}

function normalizeExtraHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce<Record<string, string>>((headers, [key, headerValue]) => {
    if (typeof headerValue === 'string') {
      headers[key] = headerValue;
    }
    return headers;
  }, {});
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeGenerationDefaults(value: unknown): LlmGenerationDefaults {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const data = value as Record<string, unknown>;
  const defaults: LlmGenerationDefaults = {};

  if (isFiniteNumber(data.temperature) && data.temperature >= 0) {
    defaults.temperature = data.temperature;
  }

  if (isFiniteNumber(data.topP) && data.topP >= 0 && data.topP <= 1) {
    defaults.topP = data.topP;
  }

  if (Number.isInteger(data.maxTokens) && Number(data.maxTokens) > 0) {
    defaults.maxTokens = Number(data.maxTokens);
  }

  if (Array.isArray(data.stopSequences)) {
    const stopSequences = data.stopSequences.filter(
      (sequence): sequence is string => typeof sequence === 'string',
    );
    if (stopSequences.length > 0) {
      defaults.stopSequences = stopSequences;
    }
  }

  return defaults;
}

function toProviderConfig(provider: SelectedLlmProviderConfig): LlmProviderConfig {
  return {
    id: String(provider.id),
    name: provider.name,
    type: fromDbProviderType(provider.type),
    enabled: provider.enabled && !provider.deletedAt,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? undefined,
    defaultModel: provider.defaultModel,
    timeoutMs: provider.timeoutMs ?? undefined,
    generationDefaults: normalizeGenerationDefaults(provider.generationDefaults),
    extraHeaders: normalizeExtraHeaders(provider.extraHeaders),
  };
}

function createAdapter(config: LlmProviderConfig): ILlmProvider | null {
  if (config.type === 'ollama') {
    return new OllamaProvider(config);
  }

  if (config.type === 'openai-compatible') {
    return new OpenAiCompatibleProvider(config);
  }

  return null;
}

function adapterUnavailable(config: LlmProviderConfig): LlmProviderOperationResult {
  logLlmEvent({
    providerId: config.id,
    providerType: config.type,
    operation: 'provider.adapterUnavailable',
    status: 'error',
    errorCode: 'ADAPTER_UNAVAILABLE',
  });

  return {
    providerId: config.id,
    providerName: config.name,
    providerType: config.type,
    status: 'error',
    errorMessage: `No adapter is available for provider type ${config.type}`,
  };
}

function toProviderModelListResult(result: LlmProviderOperationResult) {
  return {
    providerId: result.providerId,
    providerName: result.providerName,
    providerType: result.providerType,
    generationDefaults: {},
    status: result.status,
    modelCount: 0,
    capabilities: UNSUPPORTED_LLM_PROVIDER_CAPABILITIES,
    errorMessage: result.errorMessage,
    errorCode: result.errorCode,
  };
}

function createFailingStream(error: Error): AsyncIterable<LlmStreamChunk> {
  const iterator: AsyncIterator<LlmStreamChunk> = {
    next: async () => Promise.reject(error),
  };

  return {
    [Symbol.asyncIterator]: () => iterator,
  };
}

export const LlmRuntimeService = {
  normalizeExtraHeaders,

  normalizeGenerationDefaults,

  toProviderConfig,

  async ensureBootstrapProviderConfig(): Promise<void> {
    const count = await LlmProviderConfigRepository.countActive();
    if (count > 0) return;

    await LlmProviderConfigRepository.create({
      name: 'Local Ollama',
      type: 'ollama',
      baseUrl: ENV.OLLAMA_HOST,
      enabled: true,
      defaultModel: ENV.OLLAMA_MODEL,
    });
  },

  async getProviderConfigById(id: number): Promise<SelectedLlmProviderConfig> {
    const provider = await LlmProviderConfigRepository.findById(id);
    if (!provider || provider.deletedAt) {
      throw new NotFoundError('LLM provider config not found');
    }
    return provider;
  },

  createProvider(provider: SelectedLlmProviderConfig): ILlmProvider | null {
    return createAdapter(toProviderConfig(provider));
  },

  async listAvailableModels(): Promise<LlmModelListResult> {
    const providers = await LlmProviderConfigRepository.findActive();
    const adapters = providers.map((provider) => {
      const config = toProviderConfig(provider);
      const adapter = createAdapter(config);

      if (adapter) return adapter;

      return {
        id: config.id,
        type: config.type,
        isEnabled: config.enabled,
        capabilities: UNSUPPORTED_LLM_PROVIDER_CAPABILITIES,
        config,
        initialise: async () => undefined,
        destroy: async () => undefined,
        complete: async () => {
          throw new Error(`No adapter is available for provider type ${config.type}`);
        },
        streamComplete: () => createFailingStream(
          new Error(`No adapter is available for provider type ${config.type}`),
        ),
        embed: async () => {
          throw new Error(`No adapter is available for provider type ${config.type}`);
        },
        listModels: async () => {
          throw new Error(`No adapter is available for provider type ${config.type}`);
        },
      } satisfies ILlmProvider;
    });

    return new LlmRegistryService(adapters, (observation) => recordModelRegistrySampleSafely(
      observation.provider,
      observation.latencyMs,
    )).listAvailableModels();
  },

  async listProviderModels(id: number): Promise<LlmModelListResult> {
    const provider = await this.getProviderConfigById(id);
    const config = toProviderConfig(provider);
    const adapter = createAdapter(config);
    const startedAt = Date.now();

    if (!adapter) {
      const unavailable = adapterUnavailable(config);
      const providerResult = toProviderModelListResult(unavailable);
      await recordModelRegistrySampleSafely(providerResult, Date.now() - startedAt);
      return {
        models: [],
        providers: [providerResult],
      };
    }

    return new LlmRegistryService([adapter], (observation) => recordModelRegistrySampleSafely(
      observation.provider,
      observation.latencyMs,
    )).listAvailableModels();
  },

  async testProvider(id: number): Promise<LlmProviderOperationResult> {
    const provider = await this.getProviderConfigById(id);
    const config = toProviderConfig(provider);
    const adapter = createAdapter(config);
    const startedAt = Date.now();

    if (!adapter) {
      const result = adapterUnavailable(config);
      await recordProviderOperationSampleSafely(result, Date.now() - startedAt);
      return result;
    }

    logLlmEvent({
      providerId: adapter.id,
      providerType: adapter.config.type,
      operation: 'provider.test',
      status: 'started',
    });

    try {
      await adapter.initialise();
      logLlmEvent({
        providerId: adapter.id,
        providerType: adapter.config.type,
        operation: 'provider.test',
        latencyMs: Date.now() - startedAt,
        status: 'success',
      });
      const result: LlmProviderOperationResult = {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'success',
      };
      await recordProviderOperationSampleSafely(result, Date.now() - startedAt);
      return result;
    } catch (error) {
      logLlmEvent({
        providerId: adapter.id,
        providerType: adapter.config.type,
        operation: 'provider.test',
        latencyMs: Date.now() - startedAt,
        status: 'error',
        errorCode: getLlmErrorCode(error),
      });
      const result: LlmProviderOperationResult = {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'error',
        errorMessage: getErrorMessage(error),
        errorCode: getErrorCode(error),
      };
      await recordProviderOperationSampleSafely(result, Date.now() - startedAt);
      return result;
    }
  },

  async pullProviderModel(id: number, model: string): Promise<LlmProviderOperationResult> {
    const provider = await this.getProviderConfigById(id);
    const config = toProviderConfig(provider);
    const adapter = createAdapter(config);
    const startedAt = Date.now();

    if (!adapter) {
      return adapterUnavailable(config);
    }

    try {
      ensureLlmProviderCapability(adapter, 'modelPulling');
    } catch (error) {
      return {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'error',
        errorMessage: getErrorMessage(error),
        errorCode: getErrorCode(error),
      };
    }

    if (!adapter.pullModel) {
      return {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'error',
        errorMessage: `Provider type ${adapter.config.type} does not support model pull`,
      };
    }

    logLlmEvent({
      providerId: adapter.id,
      providerType: adapter.config.type,
      model,
      operation: 'provider.pullModel.runtime',
      status: 'started',
    });

    try {
      await adapter.pullModel(model);
      logLlmEvent({
        providerId: adapter.id,
        providerType: adapter.config.type,
        model,
        operation: 'provider.pullModel.runtime',
        latencyMs: Date.now() - startedAt,
        status: 'success',
      });
      return {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'success',
      };
    } catch (error) {
      logLlmEvent({
        providerId: adapter.id,
        providerType: adapter.config.type,
        model,
        operation: 'provider.pullModel.runtime',
        latencyMs: Date.now() - startedAt,
        status: 'error',
        errorCode: getLlmErrorCode(error),
      });
      return {
        providerId: adapter.id,
        providerName: adapter.config.name,
        providerType: adapter.config.type,
        status: 'error',
        errorMessage: getErrorMessage(error),
      };
    }
  },

  async embedWithProvider(params: {
    providerId: number;
    request: LlmEmbeddingRequest;
  }): Promise<LlmEmbeddingResponse> {
    const providerConfig = await this.getProviderConfigById(params.providerId);

    if (!providerConfig.enabled) {
      throw new InvalidInputError('LLM provider is disabled');
    }

    const provider = this.createProvider(providerConfig);
    if (!provider) {
      throw new InvalidInputError(`No adapter is available for provider type ${fromDbProviderType(providerConfig.type)}`);
    }

    ensureLlmProviderCapability(provider, 'embeddings');

    return provider.embed(params.request);
  },

  async resolveGenerationProvider(params: {
    providerId?: number;
    model?: string;
    operation?: Extract<LlmProviderCapability, 'completion' | 'streaming'>;
  }): Promise<{
    providerConfig: SelectedLlmProviderConfig;
    provider: ILlmProvider;
    model: string;
    generationDefaults: LlmGenerationDefaults;
  }> {
    const providerConfig = params.providerId === undefined
      ? (await LlmProviderConfigRepository.findActive())[0]
      : await LlmProviderConfigRepository.findById(params.providerId);

    if (!providerConfig || providerConfig.deletedAt) {
      throw new NotFoundError('LLM provider config not found');
    }

    if (!providerConfig.enabled) {
      throw new InvalidInputError('LLM provider is disabled');
    }

    const provider = this.createProvider(providerConfig);
    if (!provider) {
      throw new InvalidInputError(`No adapter is available for provider type ${fromDbProviderType(providerConfig.type)}`);
    }

    const operation = params.operation ?? 'completion';
    ensureLlmProviderCapability(provider, operation);

    return {
      providerConfig,
      provider,
      model: params.model ?? providerConfig.defaultModel,
      generationDefaults: normalizeGenerationDefaults(providerConfig.generationDefaults),
    };
  },
};

async function recordModelRegistrySampleSafely(
  provider: LlmProviderModelListResult,
  latencyMs: number,
): Promise<void> {
  await recordProviderSampleSafely({
    providerId: Number(provider.providerId),
    providerType: toDbProviderType(provider.providerType),
    operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
    status: toProviderHealthSampleStatus(provider.status),
    latencyMs,
    modelCount: provider.modelCount,
    errorCode: provider.errorCode,
  });
}

async function recordProviderOperationSampleSafely(
  result: LlmProviderOperationResult,
  latencyMs: number,
): Promise<void> {
  await recordProviderSampleSafely({
    providerId: Number(result.providerId),
    providerType: toDbProviderType(result.providerType),
    operation: ProviderHealthSampleOperation.PROVIDER_TEST,
    status: toProviderHealthSampleStatus(result.status),
    latencyMs,
    errorCode: result.errorCode,
  });
}

async function recordProviderSampleSafely(input: Parameters<
  typeof ProviderHealthSampleService.recordSample
>[0]): Promise<void> {
  if (!Number.isInteger(input.providerId)) return;

  try {
    await ProviderHealthSampleService.recordSample(input);
  } catch (error) {
    logger.error({
      err: error,
      providerId: input.providerId,
      providerType: input.providerType,
      operation: input.operation,
      status: input.status,
      errorCode: input.errorCode,
    }, 'Provider health sample recording failed.');
  }
}

function toProviderHealthSampleStatus(
  status: LlmProviderModelListResult['status'],
): ProviderHealthSampleStatus {
  if (status === 'success') return ProviderHealthSampleStatus.SUCCESS;
  if (status === 'skipped') return ProviderHealthSampleStatus.SKIPPED;
  return ProviderHealthSampleStatus.ERROR;
}

export type { LlmProviderType };
