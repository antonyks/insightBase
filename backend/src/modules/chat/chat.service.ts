import { Prisma } from '@prisma/client';
import { logger } from '../../config/logger';
import { ChatRepository } from './chat.repository';
import { 
  IChatSessionCreateInput, 
  IChatSessionUpdateInput, 
  IChatMessageCreateInput,
  IChatGenerationServiceInput,
  IChatGenerationResult,
  ChatGenerationStreamEvent,
  IChatGenerationParams,
  IChatWorkspaceContext,
  IChatSessionListServiceParams
} from './chat.types';
import { NotFoundError } from '../../errors';
import { SelectedChatSession, ChatSessionWithMessages, SelectedChatMessage, MessageAuthor } from './chat.model';
import { LlmRuntimeService } from '../llm/llmRuntime.service';
import { ILlmProvider } from '../llm/llm.interface';
import { LlmCompletionRequest, LlmMessage, TokenUsage } from '../llm/llm.types';
import { getLlmErrorCode, logLlmEvent } from '../llm/llm.logging';
import { CoreSingleOwnerWorkspaceAuthorizationPolicy, WorkspaceAction } from '../workspace';
import { GenerationUsageOutcome, GenerationUsageService } from '../generationUsage';

type ChatGenerationOperation = 'completion' | 'streaming';

type PreparedGeneration = {
  provider: ILlmProvider;
  workspaceId: number;
  providerMetadata: {
    providerId: string;
    providerName: string;
    providerType: string;
  };
  request: LlmCompletionRequest;
  userMessage: SelectedChatMessage;
  startedAt: number;
  params: IChatGenerationParams;
};

const workspaceAuthorizationPolicy = new CoreSingleOwnerWorkspaceAuthorizationPolicy();
const WORKSPACE_NOT_FOUND_MESSAGE = 'Workspace not found';

function toLlmRole(author: MessageAuthor): LlmMessage['role'] {
  if (author === MessageAuthor.ASSISTANT) return 'assistant';
  if (author === MessageAuthor.SYSTEM) return 'system';
  return 'user';
}

function toLlmMessages(messages: Array<{ author: MessageAuthor; content: string }>): LlmMessage[] {
  return messages.map((message) => ({
    role: toLlmRole(message.author),
    content: message.content,
  }));
}

function removeUndefinedValues<T extends Record<string, unknown>>(data: T): Record<string, unknown> {
  return Object.entries(data).reduce<Record<string, unknown>>((result, [key, value]) => {
    if (value !== undefined) {
      result[key] = value;
    }
    return result;
  }, {});
}

function applyGenerationDefaults(
  defaults: IChatGenerationParams,
  input: IChatGenerationServiceInput,
): IChatGenerationParams {
  return {
    temperature: input.temperature ?? defaults.temperature,
    topP: input.topP ?? defaults.topP,
    maxTokens: input.maxTokens ?? defaults.maxTokens,
    stopSequences: input.stopSequences ?? defaults.stopSequences,
  };
}

function createAssistantMetadata(data: {
  providerId: string;
  providerName: string;
  providerType: string;
  model: string;
  reasoning?: string;
  finishReason?: string;
  incomplete?: boolean;
  errorMessage?: string;
  usage?: TokenUsage;
  latencyMs?: number;
  params: IChatGenerationParams;
}): Prisma.InputJsonObject {
  return removeUndefinedValues({
    providerId: data.providerId,
    providerName: data.providerName,
    providerType: data.providerType,
    model: data.model,
    reasoning: data.reasoning,
    finishReason: data.finishReason,
    incomplete: data.incomplete,
    errorMessage: data.errorMessage,
    usage: data.usage,
    latencyMs: data.latencyMs,
    params: removeUndefinedValues(data.params as Record<string, unknown>),
  }) as Prisma.InputJsonObject;
}

function isIncompleteGeneration(data: {
  content: string;
  reasoning?: string;
  finishReason?: string;
}): boolean | undefined {
  if (data.reasoning && !data.content.trim()) {
    return true;
  }

  if (!data.finishReason) {
    return undefined;
  }

  const normalized = data.finishReason.toLowerCase();
  if (normalized === 'length' || normalized === 'max_tokens') {
    return true;
  }

  return undefined;
}

function ensureAuthorizedWorkspace(
  context: IChatWorkspaceContext,
  action: WorkspaceAction,
): number {
  const decision = workspaceAuthorizationPolicy.checkWorkspaceAction(
    context.actor,
    context.workspace,
    action,
  );

  if (!decision.allowed) {
    throw new NotFoundError(WORKSPACE_NOT_FOUND_MESSAGE);
  }

  return context.workspace.id;
}

async function recordGenerationUsageSafely(data: {
  prepared: PreparedGeneration;
  streaming: boolean;
  outcome: GenerationUsageOutcome;
  latencyMs: number;
  usage?: TokenUsage;
  errorCode?: string;
  model?: string;
}): Promise<void> {
  try {
    await GenerationUsageService.recordGeneration({
      workspaceId: data.prepared.workspaceId,
      providerId: Number(data.prepared.providerMetadata.providerId),
      model: data.model ?? data.prepared.request.model,
      streaming: data.streaming,
      latencyMs: data.latencyMs,
      usage: data.usage,
      outcome: data.outcome,
      errorCode: data.errorCode,
    });
  } catch (error) {
    logger.error({
      err: error,
      providerId: data.prepared.providerMetadata.providerId,
      providerType: data.prepared.providerMetadata.providerType,
      model: data.prepared.request.model,
      operation: 'generationUsage.record',
      status: 'error',
    }, 'Generation usage recording failed.');
  }
}

export const ChatService = {
  async createSession(
    data: IChatSessionCreateInput,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatSession> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.CREATE_RESOURCE);

    return await ChatRepository.createSession({
      ...data,
      workspaceId,
    });
  },

  async getSessionById(
    id: number,
    context: IChatWorkspaceContext,
  ): Promise<ChatSessionWithMessages | null> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.READ_WORKSPACE);
    const session = await ChatRepository.getSessionInWorkspace(id, workspaceId);
    
    if (!session) {
      throw new NotFoundError('Session not found');
    }
    
    return session;
  },

  async getWorkspaceSessions(
    params: IChatSessionListServiceParams,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatSession[]> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.READ_WORKSPACE);

    return await ChatRepository.listSessionsInWorkspace({
      ...params,
      workspaceId,
    });
  },

  async updateSession(
    id: number,
    data: IChatSessionUpdateInput,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatSession | null> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.UPDATE_RESOURCE);
    const session = await ChatRepository.updateSessionInWorkspace(id, workspaceId, data);
    
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    return session;
  },

  async deleteSession(
    id: number,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatSession | null> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.DELETE_RESOURCE);
    const session = await ChatRepository.deleteSessionInWorkspace(id, workspaceId);
    
    if (!session) {
      throw new NotFoundError('Session not found');
    }

    return session;
  },

  async createMessage(
    data: IChatMessageCreateInput,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatMessage> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.CREATE_RESOURCE);
    await this.ensureSessionInWorkspace(data.sessionId, workspaceId);
    return await ChatRepository.createMessage(data);
  },

  async getMessagesBySessionId(
    sessionId: number,
    context: IChatWorkspaceContext,
  ): Promise<SelectedChatMessage[] | []> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.READ_WORKSPACE);
    await this.ensureSessionInWorkspace(sessionId, workspaceId);
    return await ChatRepository.listMessagesInWorkspace(sessionId, workspaceId);
  },

  async ensureSessionInWorkspace(
    sessionId: number,
    workspaceId: number,
  ): Promise<ChatSessionWithMessages> {
    const session = await ChatRepository.getSessionInWorkspace(sessionId, workspaceId);

    if (!session) {
      throw new NotFoundError('Session not found');
    }

    return session;
  },

  async generateAssistantResponse(
    input: IChatGenerationServiceInput,
    context: IChatWorkspaceContext,
  ): Promise<IChatGenerationResult> {
    ensureAuthorizedWorkspace(context, WorkspaceAction.CREATE_RESOURCE);
    const prepared = await this.prepareGeneration(input, context, 'completion');
    logLlmEvent({
      requestId: input.requestId,
      providerId: prepared.providerMetadata.providerId,
      providerType: prepared.providerMetadata.providerType,
      model: prepared.request.model,
      operation: 'chat.complete',
      status: 'started',
    });

    try {
      const completion = await prepared.provider.complete(prepared.request);
      const latencyMs = Date.now() - prepared.startedAt;
      const assistantMessage = await ChatRepository.createMessage({
        content: completion.content,
        author: MessageAuthor.ASSISTANT,
        sessionId: input.sessionId,
        metadata: createAssistantMetadata({
          ...prepared.providerMetadata,
          model: completion.model,
          reasoning: completion.reasoning,
          finishReason: completion.finishReason,
          incomplete: isIncompleteGeneration({
            content: completion.content,
            reasoning: completion.reasoning,
            finishReason: completion.finishReason,
          }),
          usage: completion.usage,
          latencyMs: completion.latencyMs,
          params: prepared.params,
        }),
      });
      await recordGenerationUsageSafely({
        prepared,
        streaming: false,
        outcome: GenerationUsageOutcome.SUCCEEDED,
        latencyMs,
        usage: completion.usage,
        model: completion.model,
      });
      logLlmEvent({
        requestId: input.requestId,
        providerId: prepared.providerMetadata.providerId,
        providerType: prepared.providerMetadata.providerType,
        model: completion.model,
        operation: 'chat.complete',
        latencyMs,
        status: 'success',
      });

      return {
        userMessage: prepared.userMessage,
        assistantMessage,
      };
    } catch (error) {
      const latencyMs = Date.now() - prepared.startedAt;
      await recordGenerationUsageSafely({
        prepared,
        streaming: false,
        outcome: GenerationUsageOutcome.FAILED,
        latencyMs,
        errorCode: getLlmErrorCode(error),
      });
      logLlmEvent({
        requestId: input.requestId,
        providerId: prepared.providerMetadata.providerId,
        providerType: prepared.providerMetadata.providerType,
        model: prepared.request.model,
        operation: 'chat.complete',
        latencyMs,
        status: 'error',
        errorCode: getLlmErrorCode(error),
      });
      throw error;
    }
  },

  async *streamAssistantResponse(
    input: IChatGenerationServiceInput,
    context: IChatWorkspaceContext,
  ): AsyncIterable<ChatGenerationStreamEvent> {
    ensureAuthorizedWorkspace(context, WorkspaceAction.CREATE_RESOURCE);
    const prepared = await this.prepareGeneration(input, context, 'streaming');
    logLlmEvent({
      requestId: input.requestId,
      providerId: prepared.providerMetadata.providerId,
      providerType: prepared.providerMetadata.providerType,
      model: prepared.request.model,
      operation: 'chat.stream',
      status: 'started',
    });
    yield { event: 'user_message', data: prepared.userMessage };

    let content = '';
    let reasoning = '';
    let usage: TokenUsage | undefined;
    let finishReason: string | undefined;
    let assistantMessagePersisted = false;
    let completed = false;
    let failed = false;

    const persistAssistantMessage = async (options?: {
      finishReason?: string;
      incomplete?: boolean;
      errorMessage?: string;
    }): Promise<SelectedChatMessage | null> => {
      if (assistantMessagePersisted || (!content && !reasoning)) {
        return null;
      }

      assistantMessagePersisted = true;
      const resolvedFinishReason = options?.finishReason ?? finishReason;
      return ChatRepository.createMessage({
        content,
        author: MessageAuthor.ASSISTANT,
        sessionId: input.sessionId,
        metadata: createAssistantMetadata({
          ...prepared.providerMetadata,
          model: prepared.request.model,
          reasoning: reasoning || undefined,
          finishReason: resolvedFinishReason,
          incomplete: options?.incomplete ?? isIncompleteGeneration({
            content,
            reasoning: reasoning || undefined,
            finishReason: resolvedFinishReason,
          }),
          errorMessage: options?.errorMessage,
          usage,
          latencyMs: Date.now() - prepared.startedAt,
          params: prepared.params,
        }),
      });
    };

    try {
      for await (const chunk of prepared.provider.streamComplete(prepared.request)) {
        if (chunk.usage) {
          usage = chunk.usage;
        }

        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }

        if (!chunk.content && !chunk.reasoning) {
          continue;
        }

        if (chunk.content) {
          content += chunk.content;
        }

        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
        }

        yield {
          event: 'delta',
          data: removeUndefinedValues({
            content: chunk.content,
            reasoning: chunk.reasoning,
          }),
        };
      }

      const assistantMessage = await persistAssistantMessage();
      if (assistantMessage) {
        yield { event: 'assistant_message', data: assistantMessage };
      }
      completed = true;
      const latencyMs = Date.now() - prepared.startedAt;
      await recordGenerationUsageSafely({
        prepared,
        streaming: true,
        outcome: GenerationUsageOutcome.SUCCEEDED,
        latencyMs,
        usage,
      });
      logLlmEvent({
        requestId: input.requestId,
        providerId: prepared.providerMetadata.providerId,
        providerType: prepared.providerMetadata.providerType,
        model: prepared.request.model,
        operation: 'chat.stream',
        latencyMs,
        status: 'success',
      });
      yield { event: 'done', data: { done: true } };
    } catch (error) {
      failed = true;
      const latencyMs = Date.now() - prepared.startedAt;
      const errorMessage = error instanceof Error ? error.message : 'Streaming failed';
      const assistantMessage = await persistAssistantMessage({
        finishReason: 'error',
        incomplete: true,
        errorMessage,
      });
      if (assistantMessage) {
        yield { event: 'assistant_message', data: assistantMessage };
      }
      await recordGenerationUsageSafely({
        prepared,
        streaming: true,
        outcome: GenerationUsageOutcome.FAILED,
        latencyMs,
        usage,
        errorCode: getLlmErrorCode(error),
      });
      logLlmEvent({
        requestId: input.requestId,
        providerId: prepared.providerMetadata.providerId,
        providerType: prepared.providerMetadata.providerType,
        model: prepared.request.model,
        operation: 'chat.stream',
        latencyMs,
        status: 'error',
        errorCode: getLlmErrorCode(error),
      });
      throw error;
    } finally {
      if (!completed && !failed) {
        const latencyMs = Date.now() - prepared.startedAt;
        await persistAssistantMessage({
          finishReason: 'aborted',
          incomplete: true,
        });
        await recordGenerationUsageSafely({
          prepared,
          streaming: true,
          outcome: GenerationUsageOutcome.ABORTED,
          latencyMs,
          usage,
        });
        logLlmEvent({
          requestId: input.requestId,
          providerId: prepared.providerMetadata.providerId,
          providerType: prepared.providerMetadata.providerType,
          model: prepared.request.model,
          operation: 'chat.stream',
          latencyMs,
          status: 'aborted',
        });
      }
    }
  },

  async prepareGeneration(
    input: IChatGenerationServiceInput,
    context: IChatWorkspaceContext,
    operation: ChatGenerationOperation = 'completion',
  ): Promise<PreparedGeneration> {
    const workspaceId = ensureAuthorizedWorkspace(context, WorkspaceAction.READ_WORKSPACE);
    const session = await this.ensureSessionInWorkspace(input.sessionId, workspaceId);
    const resolved = await LlmRuntimeService.resolveGenerationProvider({
      providerId: input.providerId,
      model: input.model,
      operation,
    });

    const userMessage = await ChatRepository.createMessage({
      content: input.content,
      author: MessageAuthor.USER,
      sessionId: input.sessionId,
    });

    const params = applyGenerationDefaults(resolved.generationDefaults, input);

    return {
      provider: resolved.provider,
      workspaceId,
      providerMetadata: {
        providerId: String(resolved.providerConfig.id),
        providerName: resolved.providerConfig.name,
        providerType: resolved.provider.config.type,
      },
      request: {
        model: resolved.model,
        messages: toLlmMessages([...session.messages, userMessage]),
        temperature: params.temperature,
        topP: params.topP,
        maxTokens: params.maxTokens,
        stopSequences: params.stopSequences,
      },
      userMessage,
      startedAt: Date.now(),
      params,
    };
  }
};
