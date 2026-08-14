import { describe, it, expect } from '@jest/globals';
import { UserRole, WorkspaceStatus, WorkspaceType } from '@prisma/client';
import { logger } from '../../config/logger';
import { ChatService } from '../../modules/chat/chat.service';
import { mockPrisma } from '../setup';
import { GenerationUsageOutcome, GenerationUsageTokenCountSource } from '../../modules/generationUsage';
import { InvalidInputError, NotFoundError } from '../../errors';
import { SelectedChatSession, ChatSessionWithMessages, SelectedChatMessage, SelectedChatSessionFields, ChatSessionWithMessagesFields, SelectedChatMessageFields } from '../../modules/chat/chat.model';
import { SelectedLlmProviderConfig } from '../../modules/llm/llmProviderConfig.model';
import { LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE } from '../../modules/llm/llm.capabilities';
import { LlmRuntimeService } from '../../modules/llm/llmRuntime.service';
import { OllamaProvider } from '../../modules/llm/providers/ollama.provider';
import { OpenAiCompatibleProvider } from '../../modules/llm/providers/openaiCompatible.provider';
import { IChatWorkspaceContext } from '../../modules/chat/chat.types';

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../config/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const TEST_MODEL_ID = process.env.OLLAMA_MODEL as string;
const EXPLICIT_TEST_MODEL_ID = `${TEST_MODEL_ID}-explicit`;
const mockedLogger = logger as unknown as {
  info: jest.Mock;
  error: jest.Mock;
};

function loggedPayloads() {
  return [
    ...mockedLogger.info.mock.calls.map(([payload]) => payload),
    ...mockedLogger.error.mock.calls.map(([payload]) => payload),
  ];
}

function createSession(overrides: Partial<ChatSessionWithMessages> = {}): ChatSessionWithMessages {
  return {
    id: 1,
    title: 'Test Session',
    userId: 1,
    workspaceId: 25,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [],
    ...overrides,
  };
}

function createWorkspaceContext(
  overrides: Partial<IChatWorkspaceContext> = {},
): IChatWorkspaceContext {
  const workspace = overrides.workspace ?? {
    id: 25,
    name: 'Workspace',
    ownerUserId: 1,
    type: WorkspaceType.PERSONAL,
    status: WorkspaceStatus.ACTIVE,
  };

  return {
    workspace,
    actor: overrides.actor ?? {
      userId: workspace.ownerUserId,
      role: UserRole.USER,
    },
  };
}

function createWorkspaceContextFor(workspaceId: number): IChatWorkspaceContext {
  return createWorkspaceContext({
    workspace: {
      id: workspaceId,
      name: 'Workspace',
      ownerUserId: 1,
      type: WorkspaceType.PERSONAL,
      status: WorkspaceStatus.ACTIVE,
    },
  });
}

function createProvider(overrides: Partial<SelectedLlmProviderConfig> = {}): SelectedLlmProviderConfig {
  return {
    id: 1,
    name: 'Local Ollama',
    type: 'OLLAMA',
    baseUrl: 'http://localhost:11434',
    enabled: true,
    defaultModel: TEST_MODEL_ID,
    timeoutMs: 5000,
    generationDefaults: {},
    extraHeaders: {},
    apiKey: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('ChatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('createSession', () => {
    it('should create a new chat session successfully', async () => {
      const inputData = {
        title: 'Test Session',
        userId: 1,
      };

      const mockResult: SelectedChatSession = {
        id: 1,
        title: 'Test Session',
        userId: 1,
        workspaceId: 25,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.chatSession.create.mockResolvedValue(mockResult);

      const result = await ChatService.createSession(inputData, createWorkspaceContext());

      expect(result).toEqual(mockResult);
      expect(mockPrisma.chatSession.create).toHaveBeenCalledWith({
        data: {
          ...inputData,
          workspaceId: 25,
        },
        select: SelectedChatSessionFields,
      });
    });

    it('should reject a non-owner actor before creating a chat session', async () => {
      const inputData = {
        title: 'Test Session',
        userId: 2,
      };

      await expect(
        ChatService.createSession(
          inputData,
          createWorkspaceContext({
            workspace: {
              id: 25,
              name: 'Workspace',
              ownerUserId: 1,
              type: WorkspaceType.PERSONAL,
              status: WorkspaceStatus.ACTIVE,
              memberships: [{ userId: 2, role: 'EDITOR' }],
            },
            actor: {
              userId: 2,
              role: UserRole.USER,
            },
          }),
        ),
      ).rejects.toThrow(new NotFoundError('Workspace not found'));

      expect(mockPrisma.chatSession.create).not.toHaveBeenCalled();
    });
  });

  describe('getSessionById', () => {
    it('should return session with messages when it belongs to the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 25;

      const mockSession: ChatSessionWithMessages = {
        id: 1,
        title: 'Test Session',
        userId: 1,
        workspaceId: 25,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [
          {
            id: 1,
            content: 'Hello',
            author: 'USER',
            createdAt: new Date(),
          },
        ],
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(mockSession);

      const result = await ChatService.getSessionById(sessionId, createWorkspaceContextFor(workspaceId));

      expect(result).toEqual(mockSession);
      expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
        select: ChatSessionWithMessagesFields,
      });
    });

    it('should throw NotFoundError when session does not exist', async () => {
      const sessionId = 999;
      const workspaceId = 25;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.getSessionById(sessionId, createWorkspaceContextFor(workspaceId))).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });

    it('should throw NotFoundError when the session is outside the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 99;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.getSessionById(sessionId, createWorkspaceContextFor(workspaceId))).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });
  });

  describe('getWorkspaceSessions', () => {
    it('should return paginated sessions for workspace', async () => {
      const params = {
        workspaceId: 25,
        skip: 0,
        take: 10,
        orderBy: 'createdAt' as const,
        orderDirection: 'desc' as const,
      };

      const mockSessions: SelectedChatSession[] = [
        {
          id: 1,
          title: 'Session 1',
          userId: 1,
          workspaceId: 25,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 2,
          title: 'Session 2',
          userId: 1,
          workspaceId: 25,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.chatSession.findMany.mockResolvedValue(mockSessions);

      const result = await ChatService.getWorkspaceSessions(
        {
          skip: params.skip,
          take: params.take,
          orderBy: params.orderBy,
          orderDirection: params.orderDirection,
        },
        createWorkspaceContextFor(params.workspaceId),
      );

      expect(result).toEqual(mockSessions);
      expect(mockPrisma.chatSession.findMany).toHaveBeenCalledWith({
        where: { workspaceId: params.workspaceId },
        skip: params.skip,
        take: params.take,
        orderBy: { [params.orderBy]: params.orderDirection },
        select: SelectedChatSessionFields,
      });
    });

    it('should return empty array when workspace has no sessions', async () => {
      const params = {
        workspaceId: 25,
        skip: 0,
        take: 10,
      };

      mockPrisma.chatSession.findMany.mockResolvedValue([]);

      const result = await ChatService.getWorkspaceSessions(
        {
          skip: params.skip,
          take: params.take,
        },
        createWorkspaceContextFor(params.workspaceId),
      );

      expect(result).toEqual([]);
    });
  });

  describe('updateSession', () => {
    it('should update session successfully when it belongs to the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 25;
      const updateData = { title: 'Updated Title' };

      const mockUpdatedSession: SelectedChatSession = {
        id: 1,
        title: 'Updated Title',
        userId: 1,
        workspaceId: 25,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.chatSession.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.chatSession.findFirst.mockResolvedValue(mockUpdatedSession);

      const result = await ChatService.updateSession(
        sessionId,
        updateData,
        createWorkspaceContextFor(workspaceId),
      );

      expect(result).toEqual(mockUpdatedSession);
      expect(mockPrisma.chatSession.updateMany).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
        data: updateData,
      });
      expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
        select: SelectedChatSessionFields,
      });
    });

    it('should throw NotFoundError when session does not exist', async () => {
      const sessionId = 999;
      const workspaceId = 25;
      const updateData = { title: 'Updated Title' };

      mockPrisma.chatSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ChatService.updateSession(sessionId, updateData, createWorkspaceContextFor(workspaceId)),
      ).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });

    it('should throw NotFoundError when the session is outside the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 99;
      const updateData = { title: 'Updated Title' };

      mockPrisma.chatSession.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ChatService.updateSession(sessionId, updateData, createWorkspaceContextFor(workspaceId)),
      ).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });
  });

  describe('deleteSession', () => {
    it('should delete session successfully when it belongs to the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 25;

      const mockDeletedSession: SelectedChatSession = {
        id: 1,
        title: 'Test Session',
        userId: 1,
        workspaceId: 25,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(mockDeletedSession);
      mockPrisma.chatSession.deleteMany.mockResolvedValue({ count: 1 });

      const result = await ChatService.deleteSession(sessionId, createWorkspaceContextFor(workspaceId));

      expect(result).toEqual(mockDeletedSession);
      expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
        select: SelectedChatSessionFields,
      });
      expect(mockPrisma.chatSession.deleteMany).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
      });
    });

    it('should throw NotFoundError when session does not exist', async () => {
      const sessionId = 999;
      const workspaceId = 25;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.deleteSession(sessionId, createWorkspaceContextFor(workspaceId))).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });

    it('should throw NotFoundError when the session is outside the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 99;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.deleteSession(sessionId, createWorkspaceContextFor(workspaceId))).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });
  });

  describe('createMessage', () => {
    it('should create a new chat message successfully', async () => {
      const inputData = {
        content: 'Hello, AI!',
        author: 'USER' as const,
        sessionId: 1,
        metadata: { model: TEST_MODEL_ID, tokens: { prompt: 10, completion: 20, total: 30 } },
      };

      const mockResult: SelectedChatMessage = {
        id: 1,
        content: 'Hello, AI!',
        author: 'USER',
        sessionId: 1,
        metadata: inputData.metadata,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.chatMessage.create.mockResolvedValue(mockResult);

      const result = await ChatService.createMessage(inputData, createWorkspaceContextFor(1));

      expect(result).toEqual(mockResult);
      expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { id: inputData.sessionId, workspaceId: 1 },
        select: ChatSessionWithMessagesFields,
      });
      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
        data: inputData,
        select: SelectedChatMessageFields,
      });
    });

    it('should create message without metadata when not provided', async () => {
      const inputData = {
        content: 'Hello!',
        author: 'ASSISTANT' as const,
        sessionId: 1,
      };

      const mockResult: SelectedChatMessage = {
        id: 2,
        content: 'Hello!',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.chatMessage.create.mockResolvedValue(mockResult);

      const result = await ChatService.createMessage(inputData, createWorkspaceContextFor(1));

      expect(result).toEqual(mockResult);
    });

    it('should not create a message when the session does not exist', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.createMessage({
        content: 'Hello',
        author: 'USER',
        sessionId: 999,
      }, createWorkspaceContextFor(1))).rejects.toThrow(new NotFoundError('Session not found'));

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('should not create a message when the session is outside the workspace', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(ChatService.createMessage({
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
      }, createWorkspaceContextFor(99))).rejects.toThrow(new NotFoundError('Session not found'));

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('generateAssistantResponse', () => {
    it('should persist user and assistant messages with provider metadata', async () => {
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Hi there',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: {
          providerId: '1',
          providerName: 'Local Ollama',
          providerType: 'ollama',
          model: TEST_MODEL_ID,
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
          latencyMs: 12,
          params: { temperature: 0.2 },
        },
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession({
        messages: [
          {
            id: 10,
            content: 'Previous',
            author: 'USER',
            createdAt: new Date(),
          },
        ],
      }));
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      const complete = jest.spyOn(OllamaProvider.prototype, 'complete').mockResolvedValue({
        content: 'Hi there',
        reasoning: 'I should greet the user.',
        model: TEST_MODEL_ID,
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        latencyMs: 12,
      });

      const result = await ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        temperature: 0.2,
        requestId: 'req-chat-complete',
      }, createWorkspaceContextFor(25));

      expect(result).toEqual({ userMessage, assistantMessage });
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({
        model: TEST_MODEL_ID,
        temperature: 0.2,
        messages: [
          { role: 'user', content: 'Previous' },
          { role: 'user', content: 'Hello' },
        ],
      }));
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Hi there',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: expect.objectContaining({
            providerId: '1',
            providerName: 'Local Ollama',
            providerType: 'ollama',
            model: TEST_MODEL_ID,
            reasoning: 'I should greet the user.',
            finishReason: 'stop',
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 25,
          providerId: 1,
          model: TEST_MODEL_ID,
          streaming: false,
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
          tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
          outcome: GenerationUsageOutcome.SUCCEEDED,
          errorCode: undefined,
          latencyMs: expect.any(Number),
        }),
        select: expect.any(Object),
      });
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-complete',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.complete',
        status: 'started',
      }), 'chat.complete.started');
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-complete',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.complete',
        status: 'success',
        latencyMs: expect.any(Number),
      }), 'chat.complete.success');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Hello');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Hi there');
      expect(JSON.stringify(loggedPayloads())).not.toContain('I should greet the user.');
    });

    it('should resolve an explicit provider and model', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({ id: 2, defaultModel: TEST_MODEL_ID }));
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce({
          id: 1,
          content: 'Hello',
          author: 'USER',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 2,
          content: 'Done',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        });
      const complete = jest.spyOn(OllamaProvider.prototype, 'complete').mockResolvedValue({
        content: 'Done',
        model: EXPLICIT_TEST_MODEL_ID,
      });

      await ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 2,
        model: EXPLICIT_TEST_MODEL_ID,
      }, createWorkspaceContextFor(25));

      expect(mockPrisma.llmProviderConfig.findUnique).toHaveBeenCalledWith({
        where: { id: 2 },
        select: expect.any(Object),
      });
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ model: EXPLICIT_TEST_MODEL_ID }));
    });

    it('should complete through an OpenAI-compatible provider', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({
        id: 3,
        name: 'OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret-key',
        defaultModel: TEST_MODEL_ID,
      }));
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce({
          id: 1,
          content: 'Hello',
          author: 'USER',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 2,
          content: 'Cloud response',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        });
      const complete = jest.spyOn(OpenAiCompatibleProvider.prototype, 'complete').mockResolvedValue({
        content: 'Cloud response',
        reasoning: 'Provider reasoning',
        model: TEST_MODEL_ID,
        finishReason: 'stop',
        latencyMs: 14,
      });

      await ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 3,
      }, createWorkspaceContextFor(25));

      expect(complete).toHaveBeenCalledWith(expect.objectContaining({
        model: TEST_MODEL_ID,
        messages: [{ role: 'user', content: 'Hello' }],
      }));
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Cloud response',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: expect.objectContaining({
            providerId: '3',
            providerName: 'OpenAI Compatible',
            providerType: 'openai-compatible',
            model: TEST_MODEL_ID,
            reasoning: 'Provider reasoning',
            finishReason: 'stop',
            latencyMs: 14,
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(JSON.stringify(loggedPayloads())).not.toContain('secret-key');
    });

    it('should apply provider generation defaults before user overrides', async () => {
      const provider = createProvider({
        generationDefaults: {
          temperature: 0.4,
          topP: 0.9,
          maxTokens: 4096,
          stopSequences: ['END'],
        },
      });
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([provider]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce({
          id: 1,
          content: 'Hello',
          author: 'USER',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 2,
          content: 'Done',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        });
      const complete = jest.spyOn(OllamaProvider.prototype, 'complete').mockResolvedValue({
        content: 'Done',
        model: TEST_MODEL_ID,
      });

      await ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        temperature: 0.2,
      }, createWorkspaceContextFor(25));

      expect(complete).toHaveBeenCalledWith(expect.objectContaining({
        temperature: 0.2,
        topP: 0.9,
        maxTokens: 4096,
        stopSequences: ['END'],
      }));
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            params: {
              temperature: 0.2,
              topP: 0.9,
              maxTokens: 4096,
              stopSequences: ['END'],
            },
          }),
        }),
        select: SelectedChatMessageFields,
      });
    });

    it('should not persist the user message when provider resolution fails', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([]);

      await expect(ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
      }, createWorkspaceContextFor(25))).rejects.toThrow('LLM provider config not found');

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
      expect(mockPrisma.generationUsage.create).not.toHaveBeenCalled();
    });

    it('should reject unsupported completion before persisting the user message', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      const ollamaComplete = jest.spyOn(OllamaProvider.prototype, 'complete').mockResolvedValue({
        content: 'unused',
        model: TEST_MODEL_ID,
      });
      const openAiComplete = jest.spyOn(OpenAiCompatibleProvider.prototype, 'complete').mockResolvedValue({
        content: 'unused',
        model: TEST_MODEL_ID,
      });
      const error = new InvalidInputError(
        'Provider type openai-compatible does not support completion.',
        LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE,
      );
      const resolveProvider = jest.spyOn(LlmRuntimeService, 'resolveGenerationProvider').mockRejectedValue(error);

      await expect(ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 3,
        model: EXPLICIT_TEST_MODEL_ID,
      }, createWorkspaceContextFor(25))).rejects.toMatchObject({
        code: LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE,
      });

      expect(resolveProvider).toHaveBeenCalledWith({
        providerId: 3,
        model: EXPLICIT_TEST_MODEL_ID,
        operation: 'completion',
      });
      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
      expect(ollamaComplete).not.toHaveBeenCalled();
      expect(openAiComplete).not.toHaveBeenCalled();
    });

    it('should reject disabled explicit providers before persisting the user message', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({ enabled: false }));

      await expect(ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 1,
      }, createWorkspaceContextFor(25))).rejects.toThrow('LLM provider is disabled');

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('should reject deleted explicit providers before persisting the user message', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({ deletedAt: new Date() }));

      await expect(ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 1,
      }, createWorkspaceContextFor(25))).rejects.toThrow('LLM provider config not found');

      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('should not persist an assistant message when the provider fails', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create.mockResolvedValueOnce({
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      });
      jest.spyOn(OllamaProvider.prototype, 'complete').mockRejectedValue(new Error('provider offline'));

      await expect(ChatService.generateAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        requestId: 'req-chat-error',
      }, createWorkspaceContextFor(25))).rejects.toThrow('provider offline');

      expect(mockPrisma.chatMessage.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 25,
          providerId: 1,
          model: TEST_MODEL_ID,
          streaming: false,
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
          tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
          outcome: GenerationUsageOutcome.FAILED,
          errorCode: 'Error',
          latencyMs: expect.any(Number),
        }),
        select: expect.any(Object),
      });
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-error',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.complete',
        status: 'error',
        errorCode: 'Error',
        latencyMs: expect.any(Number),
      }), 'chat.complete.error');
    });
  });

  describe('streamAssistantResponse', () => {
    async function* streamChunks() {
      yield { reasoning: 'Think first. ' };
      yield { content: 'Hi' };
      yield { content: ' there', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
      yield { reasoning: 'Then finish.' };
      yield { done: true, finishReason: 'stop' };
    }

    it('should emit streaming events and persist the final assistant message', async () => {
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Hi there',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OllamaProvider.prototype, 'streamComplete').mockReturnValue(streamChunks());

      const events = [];
      for await (const event of ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        requestId: 'req-chat-stream',
      }, createWorkspaceContextFor(25))) {
        events.push(event);
      }

      expect(events).toEqual([
        { event: 'user_message', data: userMessage },
        { event: 'delta', data: { reasoning: 'Think first. ' } },
        { event: 'delta', data: { content: 'Hi' } },
        { event: 'delta', data: { content: ' there' } },
        { event: 'delta', data: { reasoning: 'Then finish.' } },
        { event: 'assistant_message', data: assistantMessage },
        { event: 'done', data: { done: true } },
      ]);
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Hi there',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            reasoning: 'Think first. Then finish.',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 25,
          providerId: 1,
          model: TEST_MODEL_ID,
          streaming: true,
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
          outcome: GenerationUsageOutcome.SUCCEEDED,
          errorCode: undefined,
          latencyMs: expect.any(Number),
        }),
        select: expect.any(Object),
      });
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-stream',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.stream',
        status: 'started',
      }), 'chat.stream.started');
      expect(mockedLogger.info).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-stream',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.stream',
        status: 'success',
        latencyMs: expect.any(Number),
      }), 'chat.stream.success');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Hello');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Hi there');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Think first.');
    });

    it('should reject unsupported streaming before persisting the user message or opening upstream', async () => {
      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      const ollamaStream = jest.spyOn(OllamaProvider.prototype, 'streamComplete').mockReturnValue((async function* emptyStream() {})());
      const openAiStream = jest.spyOn(OpenAiCompatibleProvider.prototype, 'streamComplete').mockReturnValue((async function* emptyStream() {})());
      const error = new InvalidInputError(
        'Provider type openai-compatible does not support streaming.',
        LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE,
      );
      const resolveProvider = jest.spyOn(LlmRuntimeService, 'resolveGenerationProvider').mockRejectedValue(error);

      const stream = ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 3,
        model: EXPLICIT_TEST_MODEL_ID,
      }, createWorkspaceContextFor(25))[Symbol.asyncIterator]();

      await expect(stream.next()).rejects.toMatchObject({
        code: LLM_PROVIDER_CAPABILITY_UNSUPPORTED_CODE,
      });

      expect(resolveProvider).toHaveBeenCalledWith({
        providerId: 3,
        model: EXPLICIT_TEST_MODEL_ID,
        operation: 'streaming',
      });
      expect(mockPrisma.chatMessage.create).not.toHaveBeenCalled();
      expect(ollamaStream).not.toHaveBeenCalled();
      expect(openAiStream).not.toHaveBeenCalled();
    });

    it('should stream through an OpenAI-compatible provider and persist metadata', async () => {
      async function* openAiCompatibleChunks() {
        yield { reasoning: 'Cloud reasoning. ' };
        yield { content: 'Cloud' };
        yield { content: ' answer', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } };
        yield { done: true, finishReason: 'stop' };
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Cloud answer',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({
        id: 3,
        name: 'OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret-key',
      }));
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OpenAiCompatibleProvider.prototype, 'streamComplete').mockReturnValue(openAiCompatibleChunks());

      const events = [];
      for await (const event of ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 3,
        requestId: 'req-openai-stream',
      }, createWorkspaceContextFor(25))) {
        events.push(event);
      }

      expect(events).toEqual([
        { event: 'user_message', data: userMessage },
        { event: 'delta', data: { reasoning: 'Cloud reasoning. ' } },
        { event: 'delta', data: { content: 'Cloud' } },
        { event: 'delta', data: { content: ' answer' } },
        { event: 'assistant_message', data: assistantMessage },
        { event: 'done', data: { done: true } },
      ]);
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Cloud answer',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            providerId: '3',
            providerName: 'OpenAI Compatible',
            providerType: 'openai-compatible',
            reasoning: 'Cloud reasoning. ',
            finishReason: 'stop',
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(JSON.stringify(loggedPayloads())).not.toContain('secret-key');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Cloud answer');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Cloud reasoning');
    });

    it('should persist partial assistant output when streaming fails after deltas', async () => {
      async function* failingChunks() {
        yield { content: 'Partial answer ' };
        yield { reasoning: 'Partial reasoning.' };
        throw new Error('provider timeout');
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Partial answer ',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OllamaProvider.prototype, 'streamComplete').mockReturnValue(failingChunks());

      const events = [];
      let caughtError: unknown;
      try {
        for await (const event of ChatService.streamAssistantResponse({
          sessionId: 1,
          content: 'Hello',
          requestId: 'req-chat-stream-error',
        }, createWorkspaceContextFor(25))) {
          events.push(event);
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toEqual(new Error('provider timeout'));
      expect(events).toEqual([
        { event: 'user_message', data: userMessage },
        { event: 'delta', data: { content: 'Partial answer ' } },
        { event: 'delta', data: { reasoning: 'Partial reasoning.' } },
        { event: 'assistant_message', data: assistantMessage },
      ]);
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Partial answer ',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            reasoning: 'Partial reasoning.',
            finishReason: 'error',
            incomplete: true,
            errorMessage: 'provider timeout',
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 25,
          providerId: 1,
          model: TEST_MODEL_ID,
          streaming: true,
          tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
          outcome: GenerationUsageOutcome.FAILED,
          errorCode: 'Error',
          latencyMs: expect.any(Number),
        }),
        select: expect.any(Object),
      });
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-stream-error',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.stream',
        status: 'error',
        errorCode: 'Error',
        latencyMs: expect.any(Number),
      }), 'chat.stream.error');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Partial answer');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Partial reasoning');
    });

    it('should persist OpenAI-compatible partial assistant output when upstream streaming fails', async () => {
      async function* failingOpenAiCompatibleChunks() {
        yield { content: 'Cloud partial ' };
        yield { reasoning: 'Cloud partial reasoning.' };
        throw new Error('provider stream failed');
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Cloud partial ',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({
        id: 3,
        name: 'OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
      }));
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OpenAiCompatibleProvider.prototype, 'streamComplete').mockReturnValue(failingOpenAiCompatibleChunks());

      const events = [];
      let caughtError: unknown;
      try {
        for await (const event of ChatService.streamAssistantResponse({
          sessionId: 1,
          content: 'Hello',
          providerId: 3,
          requestId: 'req-openai-stream-error',
        }, createWorkspaceContextFor(25))) {
          events.push(event);
        }
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toEqual(new Error('provider stream failed'));
      expect(events).toEqual([
        { event: 'user_message', data: userMessage },
        { event: 'delta', data: { content: 'Cloud partial ' } },
        { event: 'delta', data: { reasoning: 'Cloud partial reasoning.' } },
        { event: 'assistant_message', data: assistantMessage },
      ]);
      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Cloud partial ',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            providerId: '3',
            providerType: 'openai-compatible',
            reasoning: 'Cloud partial reasoning.',
            finishReason: 'error',
            incomplete: true,
            errorMessage: 'provider stream failed',
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(JSON.stringify(loggedPayloads())).not.toContain('Cloud partial');
    });

    it('should mark reasoning-only length finishes as incomplete', async () => {
      async function* reasoningOnlyChunks() {
        yield { reasoning: 'Long reasoning. ' };
        yield {
          done: true,
          finishReason: 'length',
          usage: { promptTokens: 1, completionTokens: 2048, totalTokens: 2049 },
        };
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: '',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OllamaProvider.prototype, 'streamComplete').mockReturnValue(reasoningOnlyChunks());

      const stream = ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
      }, createWorkspaceContextFor(25));
      while (!(await stream[Symbol.asyncIterator]().next()).done) {
        // Drain stream
      }

      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: '',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            reasoning: 'Long reasoning. ',
            finishReason: 'length',
            incomplete: true,
            usage: { promptTokens: 1, completionTokens: 2048, totalTokens: 2049 },
          }),
        }),
        select: SelectedChatMessageFields,
      });
    });

    it('should persist partial assistant output and log abort when the stream is closed early', async () => {
      async function* abortableChunks() {
        yield { content: 'Partial answer' };
        yield { content: 'This chunk should not be consumed' };
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Partial answer',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findMany.mockResolvedValue([createProvider()]);
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OllamaProvider.prototype, 'streamComplete').mockReturnValue(abortableChunks());

      const stream = ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        requestId: 'req-chat-stream-abort',
      }, createWorkspaceContextFor(25))[Symbol.asyncIterator]();

      await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'user_message', data: userMessage } });
      await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'delta', data: { content: 'Partial answer' } } });
      await stream.return?.();

      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Partial answer',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            finishReason: 'aborted',
            incomplete: true,
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(mockPrisma.generationUsage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: 25,
          providerId: 1,
          model: TEST_MODEL_ID,
          streaming: true,
          tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
          outcome: GenerationUsageOutcome.ABORTED,
          errorCode: undefined,
          latencyMs: expect.any(Number),
        }),
        select: expect.any(Object),
      });
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-chat-stream-abort',
        providerId: '1',
        providerType: 'ollama',
        model: TEST_MODEL_ID,
        operation: 'chat.stream',
        status: 'aborted',
        latencyMs: expect.any(Number),
      }), 'chat.stream.aborted');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Partial answer');
    });

    it('should persist OpenAI-compatible partial assistant output when the client aborts', async () => {
      async function* abortableOpenAiCompatibleChunks() {
        yield { content: 'Cloud partial' };
        yield { content: 'This chunk should not be consumed' };
      }
      const userMessage: SelectedChatMessage = {
        id: 1,
        content: 'Hello',
        author: 'USER',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };
      const assistantMessage: SelectedChatMessage = {
        id: 2,
        content: 'Cloud partial',
        author: 'ASSISTANT',
        sessionId: 1,
        metadata: null,
        createdAt: new Date(),
      };

      mockPrisma.chatSession.findFirst.mockResolvedValue(createSession());
      mockPrisma.llmProviderConfig.findUnique.mockResolvedValue(createProvider({
        id: 3,
        name: 'OpenAI Compatible',
        type: 'OPENAI_COMPATIBLE',
      }));
      mockPrisma.chatMessage.create
        .mockResolvedValueOnce(userMessage)
        .mockResolvedValueOnce(assistantMessage);
      jest.spyOn(OpenAiCompatibleProvider.prototype, 'streamComplete').mockReturnValue(abortableOpenAiCompatibleChunks());

      const stream = ChatService.streamAssistantResponse({
        sessionId: 1,
        content: 'Hello',
        providerId: 3,
        requestId: 'req-openai-stream-abort',
      }, createWorkspaceContextFor(25))[Symbol.asyncIterator]();

      await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'user_message', data: userMessage } });
      await expect(stream.next()).resolves.toEqual({ done: false, value: { event: 'delta', data: { content: 'Cloud partial' } } });
      await stream.return?.();

      expect(mockPrisma.chatMessage.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          content: 'Cloud partial',
          author: 'ASSISTANT',
          metadata: expect.objectContaining({
            providerId: '3',
            providerType: 'openai-compatible',
            finishReason: 'aborted',
            incomplete: true,
          }),
        }),
        select: SelectedChatMessageFields,
      });
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-openai-stream-abort',
        providerId: '3',
        providerType: 'openai-compatible',
        model: TEST_MODEL_ID,
        operation: 'chat.stream',
        status: 'aborted',
        latencyMs: expect.any(Number),
      }), 'chat.stream.aborted');
      expect(JSON.stringify(loggedPayloads())).not.toContain('Cloud partial');
    });
  });

  describe('getMessagesBySessionId', () => {
    it('should return messages when the session belongs to the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 25;

      const mockSession: ChatSessionWithMessages = {
        id: 1,
        title: 'Test Session',
        userId: 1,
        workspaceId: 25,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [],
      };

      const mockMessages: SelectedChatMessage[] = [
        {
          id: 1,
          content: 'Hello!',
          author: 'USER',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        },
        {
          id: 2,
          content: 'Hi there!',
          author: 'ASSISTANT',
          sessionId: 1,
          metadata: null,
          createdAt: new Date(),
        },
      ];

      mockPrisma.chatSession.findFirst.mockResolvedValue(mockSession);
      mockPrisma.chatMessage.findMany.mockResolvedValue(mockMessages);

      const result = await ChatService.getMessagesBySessionId(
        sessionId,
        createWorkspaceContextFor(workspaceId),
      );

      expect(result).toEqual(mockMessages);
      expect(mockPrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { id: sessionId, workspaceId },
        select: ChatSessionWithMessagesFields,
      });
      expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith({
        where: {
          sessionId,
          session: {
            workspaceId,
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
        select: SelectedChatMessageFields,
      });
    });

    it('should throw NotFoundError when session does not exist', async () => {
      const sessionId = 999;
      const workspaceId = 25;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(
        ChatService.getMessagesBySessionId(sessionId, createWorkspaceContextFor(workspaceId)),
      ).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });

    it('should throw NotFoundError when the session is outside the workspace', async () => {
      const sessionId = 1;
      const workspaceId = 99;

      mockPrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(
        ChatService.getMessagesBySessionId(sessionId, createWorkspaceContextFor(workspaceId)),
      ).rejects.toThrow(
        new NotFoundError('Session not found')
      );
    });
  });


  describe('error handling', () => {
    it('should handle Prisma errors gracefully', async () => {
      const inputData = {
        title: 'Test Session',
        userId: 1,
      };

      mockPrisma.chatSession.create.mockRejectedValue(new Error('Database connection error'));

      await expect(ChatService.createSession(inputData, createWorkspaceContext())).rejects.toThrow(
        new Error('Database connection error')
      );
    });
  });
});
