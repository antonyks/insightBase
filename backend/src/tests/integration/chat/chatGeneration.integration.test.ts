import { ServerResponse } from 'node:http';
import { MessageAuthor, Prisma, UserRole, WorkspaceStatus, WorkspaceType } from '@prisma/client';
import { logger } from '../../../config/logger';
import { NotFoundError } from '../../../errors';
import { ChatService } from '../../../modules/chat/chat.service';
import { IChatWorkspaceContext } from '../../../modules/chat/chat.types';
import { GenerationUsageOutcome, GenerationUsageTokenCountSource } from '../../../modules/generationUsage';
import { WorkspaceService } from '../../../modules/workspace/workspace.service';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import {
  createIntegrationChatMessage,
  createIntegrationChatSession,
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';
import {
  createMockLlmUpstream,
  MockLlmUpstream,
  sendChunksThenDestroy,
  sendJson,
} from '../helpers/mockLlmUpstream';

const MODEL_ID = 'integration-chat-model';
const SECRET_API_KEY = 'chat-secret-api-key';
const SECRET_HEADER_VALUE = 'chat-secret-header-value';
const USER_PROMPT = 'Private integration prompt';
const PRIOR_PROMPT = 'Private prior prompt';
const ASSISTANT_CONTENT = 'Persisted integration answer';
const ASSISTANT_REASONING = 'Persisted integration reasoning';
const STREAM_CONTENT = 'Streamed integration answer';
const STREAM_REASONING = 'Streamed integration reasoning';
const PARTIAL_CONTENT = 'Partial integration answer';

function createChatWorkspaceContext(input: {
  workspace: {
    id: number;
    name: string;
    ownerUserId: number;
    type: WorkspaceType;
    status: WorkspaceStatus;
  };
  actorUserId: number;
  actorRole?: UserRole;
}): IChatWorkspaceContext {
  return {
    workspace: input.workspace,
    actor: {
      userId: input.actorUserId,
      role: input.actorRole ?? UserRole.USER,
    },
  };
}

function createOpenAiChatRoutes() {
  return {
    'POST /chat/completions': (request: { body: string }, res: ServerResponse) => {
      const body = JSON.parse(request.body) as { stream?: boolean };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `${STREAM_REASONING} ` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Streamed ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'integration answer' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 9, completion_tokens: 10, total_tokens: 19 },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      sendJson(res, 200, {
        model: MODEL_ID,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: ASSISTANT_CONTENT,
              reasoning_content: ASSISTANT_REASONING,
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      });
    },
  };
}

function createPartialStreamFailureRoutes() {
  return {
    'POST /chat/completions': (_request: unknown, res: ServerResponse) => {
      sendChunksThenDestroy(
        res,
        'text/event-stream',
        [`data: ${JSON.stringify({ choices: [{ delta: { content: PARTIAL_CONTENT } }] })}\n\n`],
      );
    },
  };
}

async function createPersistedOpenAiProvider(upstream: MockLlmUpstream, generationDefaults?: Prisma.InputJsonObject) {
  return integrationPrisma.llmProviderConfig.create({
    data: {
      name: 'Integration OpenAI Compatible',
      type: 'OPENAI_COMPATIBLE',
      baseUrl: upstream.baseUrl,
      enabled: true,
      defaultModel: MODEL_ID,
      timeoutMs: 5000,
      generationDefaults: generationDefaults ?? {},
      extraHeaders: { 'X-Chat-Secret': SECRET_HEADER_VALUE },
      apiKey: SECRET_API_KEY,
    },
  });
}

function loggedPayloadText(): string {
  return JSON.stringify([
    ...jest.mocked(logger.info).mock.calls.map(([payload]) => payload),
    ...jest.mocked(logger.error).mock.calls.map(([payload]) => payload),
  ]);
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET_API_KEY);
  expect(text).not.toContain(SECRET_HEADER_VALUE);
}

async function getSessionMessages(sessionId: number) {
  return integrationPrisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { id: 'asc' },
  });
}

async function getGenerationUsageRows() {
  return integrationPrisma.$queryRaw<Array<{
    id: number;
    workspaceId: number;
    providerId: number;
    model: string;
    streaming: boolean;
    latencyMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    tokenCountSource: string;
    outcome: string;
    errorCode: string | null;
    createdAt: Date;
  }>>`SELECT * FROM "generation_usages" ORDER BY "id" ASC`;
}

async function closeUpstream(upstream: MockLlmUpstream): Promise<void> {
  await upstream.close();
}

beforeEach(async () => {
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  await resetIntegrationDatabase();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Chat generation PostgreSQL integration', () => {
  it('persists non-streaming user and assistant messages with provider metadata', async () => {
    const upstream = await createMockLlmUpstream(createOpenAiChatRoutes());

    try {
      const owner = await createIntegrationTestUser({ email: 'chat-generation-owner@example.com' });
      const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(owner.id);
      const provider = await createPersistedOpenAiProvider(upstream, {
        temperature: 0.4,
        topP: 0.9,
        maxTokens: 256,
        stopSequences: ['END'],
      });
      const session = await createIntegrationChatSession(owner.id, {
        workspace: { connect: { id: workspace.id } },
      });
      await createIntegrationChatMessage(session.id, {
        content: PRIOR_PROMPT,
        author: MessageAuthor.USER,
      });

      const result = await ChatService.generateAssistantResponse({
        sessionId: session.id,
        content: USER_PROMPT,
        providerId: provider.id,
        temperature: 0.2,
        requestId: 'req-integration-complete',
      }, createChatWorkspaceContext({ workspace, actorUserId: owner.id }));

      expect(result.userMessage).toMatchObject({
        content: USER_PROMPT,
        author: MessageAuthor.USER,
        sessionId: session.id,
      });
      expect(result.assistantMessage).toMatchObject({
        content: ASSISTANT_CONTENT,
        author: MessageAuthor.ASSISTANT,
        sessionId: session.id,
        metadata: expect.objectContaining({
          providerId: String(provider.id),
          providerName: provider.name,
          providerType: 'openai-compatible',
          model: MODEL_ID,
          reasoning: ASSISTANT_REASONING,
          finishReason: 'stop',
          usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
          latencyMs: expect.any(Number),
          params: {
            temperature: 0.2,
            topP: 0.9,
            maxTokens: 256,
            stopSequences: ['END'],
          },
        }),
      });

      const messages = await getSessionMessages(session.id);
      expect(messages).toHaveLength(3);
      expect(messages.map((message) => [message.author, message.content])).toEqual([
        [MessageAuthor.USER, PRIOR_PROMPT],
        [MessageAuthor.USER, USER_PROMPT],
        [MessageAuthor.ASSISTANT, ASSISTANT_CONTENT],
      ]);
      expect(messages[2].metadata).toEqual(expect.objectContaining({
        providerId: String(provider.id),
        reasoning: ASSISTANT_REASONING,
        finishReason: 'stop',
      }));
      const usageRows = await getGenerationUsageRows();
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]).toMatchObject({
        workspaceId: workspace.id,
        providerId: provider.id,
        model: MODEL_ID,
        streaming: false,
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
        outcome: GenerationUsageOutcome.SUCCEEDED,
        errorCode: null,
      });

      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0].headers).toMatchObject({
        authorization: `Bearer ${SECRET_API_KEY}`,
        'x-chat-secret': SECRET_HEADER_VALUE,
      });
      expect(JSON.parse(upstream.requests[0].body)).toMatchObject({
        model: MODEL_ID,
        messages: [
          { role: 'user', content: PRIOR_PROMPT },
          { role: 'user', content: USER_PROMPT },
        ],
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 256,
        stop: ['END'],
        stream: false,
      });
      expectNoSecrets(result);
      expectNoSecrets(messages[2].metadata);
      expectNoSecrets(usageRows);
      expect(JSON.stringify(usageRows)).not.toContain(USER_PROMPT);
      expect(JSON.stringify(usageRows)).not.toContain(PRIOR_PROMPT);
      expect(JSON.stringify(usageRows)).not.toContain(ASSISTANT_CONTENT);
      expect(JSON.stringify(usageRows)).not.toContain(ASSISTANT_REASONING);
      expect(JSON.stringify(usageRows)).not.toContain('END');
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_HEADER_VALUE);
      expect(loggedPayloadText()).not.toContain(USER_PROMPT);
      expect(loggedPayloadText()).not.toContain(ASSISTANT_CONTENT);
      expect(loggedPayloadText()).not.toContain(ASSISTANT_REASONING);
    } finally {
      await closeUpstream(upstream);
    }
  });

  it('persists successful streaming output with accumulated metadata', async () => {
    const upstream = await createMockLlmUpstream(createOpenAiChatRoutes());

    try {
      const owner = await createIntegrationTestUser({ email: 'chat-stream-owner@example.com' });
      const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(owner.id);
      const provider = await createPersistedOpenAiProvider(upstream);
      const session = await createIntegrationChatSession(owner.id, {
        workspace: { connect: { id: workspace.id } },
      });
      const events = [];

      for await (const event of ChatService.streamAssistantResponse({
        sessionId: session.id,
        content: USER_PROMPT,
        providerId: provider.id,
        requestId: 'req-integration-stream',
      }, createChatWorkspaceContext({ workspace, actorUserId: owner.id }))) {
        events.push(event);
      }

      expect(events).toEqual([
        { event: 'user_message', data: expect.objectContaining({ content: USER_PROMPT }) },
        { event: 'delta', data: { reasoning: `${STREAM_REASONING} ` } },
        { event: 'delta', data: { content: 'Streamed ' } },
        { event: 'delta', data: { content: 'integration answer' } },
        { event: 'assistant_message', data: expect.objectContaining({ content: STREAM_CONTENT }) },
        { event: 'done', data: { done: true } },
      ]);

      const messages = await getSessionMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        content: USER_PROMPT,
        author: MessageAuthor.USER,
        sessionId: session.id,
      });
      expect(messages[1]).toMatchObject({
        content: STREAM_CONTENT,
        author: MessageAuthor.ASSISTANT,
        sessionId: session.id,
        metadata: expect.objectContaining({
          providerId: String(provider.id),
          providerName: provider.name,
          providerType: 'openai-compatible',
          model: MODEL_ID,
          reasoning: `${STREAM_REASONING} `,
          finishReason: 'stop',
          usage: { promptTokens: 9, completionTokens: 10, totalTokens: 19 },
          latencyMs: expect.any(Number),
          params: {},
        }),
      });
      const usageRows = await getGenerationUsageRows();
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]).toMatchObject({
        workspaceId: workspace.id,
        providerId: provider.id,
        model: MODEL_ID,
        streaming: true,
        inputTokens: 9,
        outputTokens: 10,
        totalTokens: 19,
        tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
        outcome: GenerationUsageOutcome.SUCCEEDED,
        errorCode: null,
      });
      expect(upstream.requests).toHaveLength(1);
      expect(JSON.parse(upstream.requests[0].body)).toMatchObject({
        model: MODEL_ID,
        messages: [{ role: 'user', content: USER_PROMPT }],
        stream: true,
      });
      expectNoSecrets(messages[1].metadata);
      expectNoSecrets(usageRows);
      expect(JSON.stringify(usageRows)).not.toContain(USER_PROMPT);
      expect(JSON.stringify(usageRows)).not.toContain(STREAM_CONTENT);
      expect(JSON.stringify(usageRows)).not.toContain(STREAM_REASONING);
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_HEADER_VALUE);
      expect(loggedPayloadText()).not.toContain(USER_PROMPT);
      expect(loggedPayloadText()).not.toContain(STREAM_CONTENT);
      expect(loggedPayloadText()).not.toContain(STREAM_REASONING);
    } finally {
      await closeUpstream(upstream);
    }
  });

  it('persists partial assistant output when streaming fails after deltas', async () => {
    const upstream = await createMockLlmUpstream(createPartialStreamFailureRoutes());

    try {
      const owner = await createIntegrationTestUser({ email: 'chat-partial-stream-owner@example.com' });
      const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(owner.id);
      const provider = await createPersistedOpenAiProvider(upstream);
      const session = await createIntegrationChatSession(owner.id, {
        workspace: { connect: { id: workspace.id } },
      });
      const events = [];
      let caughtError: unknown;

      try {
        for await (const event of ChatService.streamAssistantResponse({
          sessionId: session.id,
          content: USER_PROMPT,
          providerId: provider.id,
          requestId: 'req-integration-partial-stream',
        }, createChatWorkspaceContext({ workspace, actorUserId: owner.id }))) {
          events.push(event);
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toMatchObject({
        providerId: String(provider.id),
        code: 'UPSTREAM_STREAM_ERROR',
      });
      expect(events).toEqual([
        { event: 'user_message', data: expect.objectContaining({ content: USER_PROMPT }) },
        { event: 'delta', data: { content: PARTIAL_CONTENT } },
        { event: 'assistant_message', data: expect.objectContaining({ content: PARTIAL_CONTENT }) },
      ]);

      const messages = await getSessionMessages(session.id);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        content: PARTIAL_CONTENT,
        author: MessageAuthor.ASSISTANT,
        sessionId: session.id,
        metadata: expect.objectContaining({
          providerId: String(provider.id),
          providerType: 'openai-compatible',
          model: MODEL_ID,
          finishReason: 'error',
          incomplete: true,
          errorMessage: expect.any(String),
        }),
      });
      const usageRows = await getGenerationUsageRows();
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0]).toMatchObject({
        workspaceId: workspace.id,
        providerId: provider.id,
        model: MODEL_ID,
        streaming: true,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
        outcome: GenerationUsageOutcome.FAILED,
        errorCode: 'UPSTREAM_STREAM_ERROR',
      });
      expect(upstream.requests).toHaveLength(1);
      expectNoSecrets(messages[1].metadata);
      expectNoSecrets(usageRows);
      expect(JSON.stringify(usageRows)).not.toContain(USER_PROMPT);
      expect(JSON.stringify(usageRows)).not.toContain(PARTIAL_CONTENT);
      expect(loggedPayloadText()).not.toContain(SECRET_API_KEY);
      expect(loggedPayloadText()).not.toContain(SECRET_HEADER_VALUE);
      expect(loggedPayloadText()).not.toContain(USER_PROMPT);
      expect(loggedPayloadText()).not.toContain(PARTIAL_CONTENT);
    } finally {
      await closeUpstream(upstream);
    }
  });

  it('rejects cross-workspace generation before writing messages or opening upstream', async () => {
    const upstream = await createMockLlmUpstream(createOpenAiChatRoutes());

    try {
      const owner = await createIntegrationTestUser({ email: 'chat-cross-workspace-owner@example.com' });
      const { workspace: personalWorkspace } =
        await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(owner.id);
      const standardWorkspace = await WorkspaceService.createStandardWorkspace({
        ownerUserId: owner.id,
        name: 'Generation Project Workspace',
      });
      const provider = await createPersistedOpenAiProvider(upstream);
      const standardSession = await createIntegrationChatSession(owner.id, {
        workspace: { connect: { id: standardWorkspace.id } },
      });

      await expect(ChatService.generateAssistantResponse({
        sessionId: standardSession.id,
        content: USER_PROMPT,
        providerId: provider.id,
      }, createChatWorkspaceContext({
        workspace: personalWorkspace,
        actorUserId: owner.id,
      }))).rejects.toThrow(new NotFoundError('Session not found'));

      await expect(integrationPrisma.chatMessage.count()).resolves.toBe(0);
      await expect(
        integrationPrisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) AS count FROM "generation_usages"`,
      ).resolves.toEqual([{ count: 0n }]);
      expect(upstream.requests).toHaveLength(0);
    } finally {
      await closeUpstream(upstream);
    }
  });
});
