import { ILlmProvider } from './llm.interface';
import { ensureLlmProviderCapability } from './llm.capabilities';
import {
  LlmListedModel,
  LlmModelListResult,
  LlmProviderModelListResult,
} from './llm.types';

export interface LlmProviderModelListObservation {
  provider: LlmProviderModelListResult;
  latencyMs: number;
}

export type LlmProviderModelListObserver = (
  observation: LlmProviderModelListObservation,
) => Promise<void> | void;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown provider error';
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  return undefined;
}

export class LlmRegistryService {
  constructor(
    private readonly providers: ILlmProvider[],
    private readonly observer?: LlmProviderModelListObserver,
  ) {}

  async listAvailableModels(): Promise<LlmModelListResult> {
    const providerResults = await Promise.all(
      this.providers.map((provider) => this.listProviderModels(provider)),
    );

    return {
      models: providerResults.flatMap((result) => result.models),
      providers: providerResults.map((result) => result.provider),
    };
  }

  private async listProviderModels(provider: ILlmProvider): Promise<{
    models: LlmListedModel[];
    provider: LlmProviderModelListResult;
  }> {
    const startedAt = Date.now();
    const baseModelResult = {
      providerId: provider.id,
      providerName: provider.config.name,
      providerType: provider.config.type,
    };
    const baseProviderResult = {
      ...baseModelResult,
      generationDefaults: provider.config.generationDefaults ?? {},
    };

    if (!provider.isEnabled) {
      return this.observeProviderResult({
        models: [],
        provider: {
          ...baseProviderResult,
          status: 'skipped',
          modelCount: 0,
          capabilities: provider.capabilities,
        },
      }, startedAt);
    }

    try {
      ensureLlmProviderCapability(provider, 'modelListing');
      const listedModels = await provider.listModels();
      const models = listedModels.map((model) => ({
        ...baseModelResult,
        modelId: model.modelId,
        modelName: model.modelName,
        capabilities: model.capabilities,
      }));

      return this.observeProviderResult({
        models,
        provider: {
          ...baseProviderResult,
          status: 'success',
          modelCount: models.length,
          capabilities: provider.capabilities,
        },
      }, startedAt);
    } catch (error) {
      return this.observeProviderResult({
        models: [],
        provider: {
          ...baseProviderResult,
          status: 'error',
          modelCount: 0,
          capabilities: provider.capabilities,
          errorMessage: getErrorMessage(error),
          errorCode: getErrorCode(error),
        },
      }, startedAt);
    }
  }

  private async observeProviderResult(result: {
    models: LlmListedModel[];
    provider: LlmProviderModelListResult;
  }, startedAt: number): Promise<{
    models: LlmListedModel[];
    provider: LlmProviderModelListResult;
  }> {
    if (this.observer) {
      await this.observer({
        provider: result.provider,
        latencyMs: Date.now() - startedAt,
      });
    }

    return result;
  }
}
