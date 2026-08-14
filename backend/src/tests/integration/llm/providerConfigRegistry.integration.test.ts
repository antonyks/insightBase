import jwt from 'jsonwebtoken';
import { ServerResponse } from 'node:http';
import {
  Prisma,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
  UserRole,
} from '@prisma/client';
import { logger } from '../../../config/logger';
import { authenticate, authorizeRoles } from '../../../middleware';
import { LlmProviderController } from '../../../modules/admin/llm/llmProvider.controller';
import { LlmController } from '../../../modules/llm/llm.controller';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import { AuthenticatedRequest } from '../../../types/authenticatedRequest';
import { createMockNext, createMockResponse } from '../../testUtils';
import { createIntegrationTestUser, integrationPrisma, resetIntegrationDatabase } from '../helpers/prisma';
import {
  createMockLlmUpstream,
  MockLlmUpstream,
  sendJson,
} from '../helpers/mockLlmUpstream';

const OLLAMA_MODEL_ID = 'persisted-ollama-model';
const OPENAI_MODEL_ID = 'persisted-openai-model';
const FAILING_MODEL_ID = 'failing-openai-model';
const SECRET_API_KEY = 'persisted-secret-api-key';
const EXTRA_HEADER_VALUE = 'persisted-extra-header-value';

const UNKNOWN_MODEL_CAPABILITIES = {
  completion: 'UNKNOWN',
  streaming: 'UNKNOWN',
  reasoning: 'UNKNOWN',
  embeddings: 'UNKNOWN',
  toolCalling: 'UNKNOWN',
  structuredOutput: 'UNKNOWN',
  tokenCounting: 'UNKNOWN',
};

const OLLAMA_PROVIDER_CAPABILITIES = {
  completion: true,
  streaming: true,
  reasoning: true,
  modelListing: true,
  modelPulling: true,
  embeddings: true,
  toolCalling: false,
  structuredOutput: false,
  tokenCounting: false,
};

const OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES = {
  completion: true,
  streaming: true,
  reasoning: true,
  modelListing: true,
  modelPulling: false,
  embeddings: true,
  toolCalling: false,
  structuredOutput: false,
  tokenCounting: false,
};

type ProviderType = 'OLLAMA' | 'OPENAI_COMPATIBLE';

function createOllamaRoutes(modelId: string) {
  return {
    'GET /api/tags': (_request: unknown, res: ServerResponse) => {
      sendJson(res, 200, { models: [{ name: modelId }] });
    },
  };
}

function createOpenAiRoutes(modelId: string) {
  return {
    'GET /models': (_request: unknown, res: ServerResponse) => {
      sendJson(res, 200, { object: 'list', data: [{ id: modelId, object: 'model' }] });
    },
  };
}

function createOpenAiUnsupportedModelListRoutes() {
  return {
    'GET /models': (_request: unknown, res: ServerResponse) => {
      sendJson(res, 404, { error: { message: 'model listing unavailable' } });
    },
  };
}

function signToken(user: {
  id: number;
  email: string;
  name: string | null;
  role: UserRole;
  status: string;
}) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
    },
    process.env.JWT_SECRET as string,
    { expiresIn: '1d' },
  );
}

function createRequest(token: string, workspaceId: number, overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    ...overrides,
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': String(workspaceId),
      ...(overrides.headers ?? {}),
    },
  } as AuthenticatedRequest;
}

async function createAuthenticatedRequest(role: UserRole, overrides: Partial<AuthenticatedRequest> = {}) {
  const user = await createIntegrationTestUser({ role });
  const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(user.id);
  const request = createRequest(signToken(user), workspace.id, overrides);
  const next = createMockNext();

  await authenticate(request, {} as never, next);
  expect(next).toHaveBeenCalledTimes(1);

  return request;
}

async function createAdminRequest(overrides: Partial<AuthenticatedRequest> = {}) {
  const request = await createAuthenticatedRequest(UserRole.ADMIN, overrides);
  const next = createMockNext();

  authorizeRoles(UserRole.ADMIN)(request, {} as never, next);
  expect(next).toHaveBeenCalledTimes(1);

  return request;
}

async function createPersistedProvider(params: {
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  enabled?: boolean;
  deletedAt?: Date | null;
  generationDefaults?: Prisma.InputJsonObject;
}) {
  return integrationPrisma.llmProviderConfig.create({
    data: {
      name: params.name,
      type: params.type,
      baseUrl: params.baseUrl,
      enabled: params.enabled ?? true,
      defaultModel: params.defaultModel,
      timeoutMs: 5000,
      generationDefaults: params.generationDefaults ?? {},
      extraHeaders: { 'X-Provider-Header': EXTRA_HEADER_VALUE },
      apiKey: SECRET_API_KEY,
      deletedAt: params.deletedAt ?? null,
    },
  });
}

function responseBody(res: ReturnType<typeof createMockResponse>) {
  return res.json.mock.calls[0][0] as { data: unknown };
}

function loggedPayloadText(): string {
  return JSON.stringify([
    ...jest.mocked(logger.info).mock.calls.map(([payload]) => payload),
    ...jest.mocked(logger.error).mock.calls.map(([payload]) => payload),
  ]);
}

async function closeUpstreams(upstreams: MockLlmUpstream[]) {
  await Promise.all(upstreams.map((upstream) => upstream.close()));
}

beforeEach(async () => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  await resetIntegrationDatabase();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Persisted LLM provider and model registry integration', () => {
  it('returns sanitized admin provider responses and tests persisted provider configs', async () => {
    const ollamaUpstream = await createMockLlmUpstream(createOllamaRoutes(OLLAMA_MODEL_ID));
    const openAiUpstream = await createMockLlmUpstream(createOpenAiRoutes(OPENAI_MODEL_ID));

    try {
      const ollamaProvider = await createPersistedProvider({
        name: 'Persisted Ollama',
        type: 'OLLAMA',
        baseUrl: ollamaUpstream.baseUrl,
        defaultModel: OLLAMA_MODEL_ID,
      });
      const openAiProvider = await createPersistedProvider({
        name: 'Persisted OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: openAiUpstream.baseUrl,
        defaultModel: OPENAI_MODEL_ID,
      });

      const listResponse = createMockResponse();
      await LlmProviderController.listProviders(await createAdminRequest(), listResponse);

      expect(listResponse.status).toHaveBeenCalledWith(200);
      expect(responseBody(listResponse).data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: openAiProvider.id,
          name: 'Persisted OpenAI Compatible',
          type: 'openai-compatible',
          hasApiKey: true,
          capabilities: OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES,
        }),
        expect.objectContaining({
          id: ollamaProvider.id,
          name: 'Persisted Ollama',
          type: 'ollama',
          hasApiKey: true,
          capabilities: OLLAMA_PROVIDER_CAPABILITIES,
        }),
      ]));

      const detailResponse = createMockResponse();
      await LlmProviderController.getProvider(
        await createAdminRequest({ params: { id: String(ollamaProvider.id) } }),
        detailResponse,
      );

      expect(detailResponse.status).toHaveBeenCalledWith(200);
      expect(responseBody(detailResponse).data).toEqual(expect.objectContaining({
        id: ollamaProvider.id,
        type: 'ollama',
        hasApiKey: true,
        capabilities: OLLAMA_PROVIDER_CAPABILITIES,
      }));

      const testResponse = createMockResponse();
      await LlmProviderController.testProvider(
        await createAdminRequest({ params: { id: String(openAiProvider.id) } }),
        testResponse,
      );

      expect(testResponse.status).toHaveBeenCalledWith(200);
      expect(responseBody(testResponse).data).toEqual({
        providerId: String(openAiProvider.id),
        providerName: 'Persisted OpenAI Compatible',
        providerType: 'openai-compatible',
        status: 'success',
      });
      expect(openAiUpstream.requests).toHaveLength(1);
      expect(openAiUpstream.requests[0].headers).toMatchObject({
        authorization: `Bearer ${SECRET_API_KEY}`,
        'x-provider-header': EXTRA_HEADER_VALUE,
      });
      await expect(
        integrationPrisma.providerHealthSample.findFirstOrThrow({
          where: {
            providerId: openAiProvider.id,
            operation: ProviderHealthSampleOperation.PROVIDER_TEST,
          },
        }),
      ).resolves.toMatchObject({
        providerId: openAiProvider.id,
        providerType: 'OPENAI_COMPATIBLE',
        operation: ProviderHealthSampleOperation.PROVIDER_TEST,
        status: ProviderHealthSampleStatus.SUCCESS,
        errorCode: null,
      });

      const capturedResponseText = JSON.stringify([
        responseBody(listResponse),
        responseBody(detailResponse),
        responseBody(testResponse),
      ]);
      expect(capturedResponseText).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(EXTRA_HEADER_VALUE);
    } finally {
      await closeUpstreams([ollamaUpstream, openAiUpstream]);
    }
  });

  it('aggregates persisted active provider models and excludes disabled or deleted configs', async () => {
    const ollamaUpstream = await createMockLlmUpstream(createOllamaRoutes(OLLAMA_MODEL_ID));
    const openAiUpstream = await createMockLlmUpstream(createOpenAiRoutes(OPENAI_MODEL_ID));
    const disabledUpstream = await createMockLlmUpstream(createOllamaRoutes('disabled-model'));
    const deletedUpstream = await createMockLlmUpstream(createOpenAiRoutes('deleted-model'));

    try {
      const ollamaProvider = await createPersistedProvider({
        name: 'Active Persisted Ollama',
        type: 'OLLAMA',
        baseUrl: ollamaUpstream.baseUrl,
        defaultModel: OLLAMA_MODEL_ID,
        generationDefaults: { temperature: 0.2, topP: 0.9, maxTokens: 128 },
      });
      const openAiProvider = await createPersistedProvider({
        name: 'Active Persisted OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: openAiUpstream.baseUrl,
        defaultModel: OPENAI_MODEL_ID,
        generationDefaults: { temperature: 0.4, stopSequences: ['END'] },
      });
      await createPersistedProvider({
        name: 'Disabled Persisted Ollama',
        type: 'OLLAMA',
        baseUrl: disabledUpstream.baseUrl,
        defaultModel: 'disabled-model',
        enabled: false,
      });
      await createPersistedProvider({
        name: 'Deleted Persisted OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: deletedUpstream.baseUrl,
        defaultModel: 'deleted-model',
        deletedAt: new Date('2026-08-07T00:00:00.000Z'),
      });

      const response = createMockResponse();
      await LlmController.listAvailableModels(await createAuthenticatedRequest(UserRole.USER), response);

      expect(response.status).toHaveBeenCalledWith(200);
      expect(responseBody(response).data).toMatchObject({
        models: expect.arrayContaining([
          {
            providerId: String(ollamaProvider.id),
            providerName: 'Active Persisted Ollama',
            providerType: 'ollama',
            modelId: OLLAMA_MODEL_ID,
            modelName: OLLAMA_MODEL_ID,
            capabilities: UNKNOWN_MODEL_CAPABILITIES,
          },
          {
            providerId: String(openAiProvider.id),
            providerName: 'Active Persisted OpenAI Compatible',
            providerType: 'openai-compatible',
            modelId: OPENAI_MODEL_ID,
            modelName: OPENAI_MODEL_ID,
            capabilities: UNKNOWN_MODEL_CAPABILITIES,
          },
        ]),
        providers: expect.arrayContaining([
          expect.objectContaining({
            providerId: String(ollamaProvider.id),
            status: 'success',
            modelCount: 1,
            capabilities: OLLAMA_PROVIDER_CAPABILITIES,
            generationDefaults: { temperature: 0.2, topP: 0.9, maxTokens: 128 },
          }),
          expect.objectContaining({
            providerId: String(openAiProvider.id),
            status: 'success',
            modelCount: 1,
            capabilities: OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES,
            generationDefaults: { temperature: 0.4, stopSequences: ['END'] },
          }),
        ]),
      });
      expect((responseBody(response).data as { models: unknown[] }).models).toHaveLength(2);
      expect((responseBody(response).data as { providers: unknown[] }).providers).toHaveLength(2);
      expect(ollamaUpstream.requests).toHaveLength(1);
      expect(openAiUpstream.requests).toHaveLength(1);
      expect(disabledUpstream.requests).toHaveLength(0);
      expect(deletedUpstream.requests).toHaveLength(0);
      await expect(
        integrationPrisma.providerHealthSample.findMany({
          where: {
            operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
          },
          orderBy: { providerId: 'asc' },
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          providerId: ollamaProvider.id,
          providerType: 'OLLAMA',
          status: ProviderHealthSampleStatus.SUCCESS,
          modelCount: 1,
        }),
        expect.objectContaining({
          providerId: openAiProvider.id,
          providerType: 'OPENAI_COMPATIBLE',
          status: ProviderHealthSampleStatus.SUCCESS,
          modelCount: 1,
        }),
      ]);
      expect(JSON.stringify(responseBody(response))).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(EXTRA_HEADER_VALUE);
    } finally {
      await closeUpstreams([ollamaUpstream, openAiUpstream, disabledUpstream, deletedUpstream]);
    }
  });

  it('returns normalized provider-specific model-listing errors without crashing', async () => {
    const failingUpstream = await createMockLlmUpstream(createOpenAiUnsupportedModelListRoutes());

    try {
      const provider = await createPersistedProvider({
        name: 'Unsupported Model List Provider',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: failingUpstream.baseUrl,
        defaultModel: FAILING_MODEL_ID,
      });

      const response = createMockResponse();
      await LlmController.listProviderModels(
        await createAuthenticatedRequest(UserRole.USER, { params: { id: String(provider.id) } }),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(200);
      expect(responseBody(response).data).toEqual({
        models: [],
        providers: [
          expect.objectContaining({
            providerId: String(provider.id),
            providerName: 'Unsupported Model List Provider',
            providerType: 'openai-compatible',
            status: 'error',
            modelCount: 0,
            capabilities: OPENAI_COMPATIBLE_PROVIDER_CAPABILITIES,
            errorCode: 'MODEL_LISTING_UNSUPPORTED',
          }),
        ],
      });
      expect(failingUpstream.requests).toHaveLength(1);
      expect(JSON.stringify(responseBody(response))).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(EXTRA_HEADER_VALUE);
    } finally {
      await closeUpstreams([failingUpstream]);
    }
  });
});
