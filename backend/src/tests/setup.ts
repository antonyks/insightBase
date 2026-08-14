import { PrismaClient } from '@prisma/client';
import { jest } from '@jest/globals';
import { SelectedUser } from '../modules/user/user.model';
import { SelectedChatSession, SelectedChatMessage } from '../modules/chat/chat.model';
import { SelectedLlmProviderConfig } from '../modules/llm/llmProviderConfig.model';
import { SelectedJob } from '../modules/job/job.model';

process.env.OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? `test-${Date.now()}`;

type UserCreateResult = Awaited<ReturnType<PrismaClient['user']['create']>>;
type chatSessionResult = Awaited<ReturnType<PrismaClient['chatSession']['create']>>;
type chatMessageResult = Awaited<ReturnType<PrismaClient['chatMessage']['create']>>;
type jobResult = SelectedJob;
type generationUsageResult = {
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
};

const mockPrisma = {
  $queryRaw: jest.fn<() => Promise<unknown>>(),
  $executeRaw: jest.fn<() => Promise<unknown>>(),
  $transaction: jest.fn(),
  user: {
    create: jest.fn<() => Promise<UserCreateResult>>(),
    findUnique: jest.fn<() => Promise<SelectedUser | null>>(),
    findMany: jest.fn<() => Promise<SelectedUser[]>>(),
    update: jest.fn<() => Promise<SelectedUser>>(),
    count: jest.fn<() => Promise<number>>(),
  },
  chatSession: {
    create: jest.fn<() => Promise<chatSessionResult>>(),
    findUnique: jest.fn<() => Promise<SelectedChatSession | null>>(),
    findFirst: jest.fn<() => Promise<SelectedChatSession | null>>(),
    findMany: jest.fn<() => Promise<SelectedChatSession[]>>(),
    update: jest.fn<() => Promise<SelectedChatSession>>(),
    updateMany: jest.fn<() => Promise<{ count: number }>>(),
    delete: jest.fn<() => Promise<SelectedChatSession>>(),
    deleteMany: jest.fn<() => Promise<{ count: number }>>(),
  },
  chatMessage: {
    create: jest.fn<() => Promise<chatMessageResult>>(),
    findUnique: jest.fn<() => Promise<SelectedChatMessage | null>>(),
    findMany: jest.fn<() => Promise<SelectedChatMessage[]>>(),
    update: jest.fn<() => Promise<SelectedChatMessage>>(),
    delete: jest.fn<() => Promise<SelectedChatMessage>>(),
  },
  llmProviderConfig: {
    create: jest.fn<() => Promise<SelectedLlmProviderConfig>>(),
    findUnique: jest.fn<() => Promise<SelectedLlmProviderConfig | null>>(),
    findMany: jest.fn<() => Promise<SelectedLlmProviderConfig[]>>(),
    update: jest.fn<() => Promise<SelectedLlmProviderConfig>>(),
    count: jest.fn<() => Promise<number>>(),
  },
  workspace: {
    create: jest.fn<() => Promise<unknown>>(),
    findFirst: jest.fn<() => Promise<unknown>>(),
    findMany: jest.fn<() => Promise<unknown[]>>(),
    update: jest.fn<() => Promise<unknown>>(),
    count: jest.fn<() => Promise<number>>(),
  },
  workspaceMembership: {
    create: jest.fn<() => Promise<unknown>>(),
    findFirst: jest.fn<() => Promise<unknown>>(),
    findUnique: jest.fn<() => Promise<unknown>>(),
    update: jest.fn<() => Promise<unknown>>(),
    count: jest.fn<() => Promise<number>>(),
  },
  job: {
    create: jest.fn<() => Promise<jobResult>>(),
    findUnique: jest.fn<() => Promise<jobResult | null>>(),
    findFirst: jest.fn<() => Promise<jobResult | null>>(),
    findMany: jest.fn<() => Promise<jobResult[]>>(),
    update: jest.fn<() => Promise<jobResult>>(),
    count: jest.fn<() => Promise<number>>(),
  },
  generationUsage: {
    create: jest.fn<(args: unknown) => Promise<generationUsageResult>>(),
    findMany: jest.fn<() => Promise<generationUsageResult[]>>(),
    count: jest.fn<() => Promise<number>>(),
  },
};

mockPrisma.$transaction.mockImplementation(
  (callback: unknown) => {
    if (typeof callback !== 'function') {
      throw new Error('Mock Prisma transaction expects a callback.');
    }

    return (callback as (transactionClient: typeof mockPrisma) => unknown)(mockPrisma);
  },
);


class MockPrismaClientKnownRequestError extends Error {
  code: string;
  meta?: Record<string, unknown>;
  clientVersion: string;

  constructor(
    message: string,
    { code, clientVersion, meta }: { code: string; clientVersion: string; meta?: Record<string, unknown> }
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
    this.clientVersion = clientVersion;
    this.meta = meta;
  }
}




jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  UserStatus: {
    ACTIVE: 'ACTIVE',
    BANNED: 'BANNED',
    DELETED: 'DELETED',
  },
  UserRole: {
    USER: 'USER',
    ADMIN: 'ADMIN',
  },
  WorkspaceType: {
    PERSONAL: 'PERSONAL',
    STANDARD: 'STANDARD',
  },
  WorkspaceStatus: {
    ACTIVE: 'ACTIVE',
    DELETED: 'DELETED',
  },
  WorkspaceMembershipRole: {
    OWNER: 'OWNER',
    EDITOR: 'EDITOR',
    VIEWER: 'VIEWER',
  },
  WorkspaceMembershipStatus: {
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
  },
  MessageAuthor: {
    USER: 'USER',
    ASSISTANT: 'ASSISTANT',
    SYSTEM: 'SYSTEM',
  },
  LlmProviderConfigType: {
    OLLAMA: 'OLLAMA',
    OPENAI_COMPATIBLE: 'OPENAI_COMPATIBLE',
  },
  JobStatus: {
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    CANCEL_REQUESTED: 'CANCEL_REQUESTED',
    CANCELLED: 'CANCELLED',
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
  },
  GenerationUsageOutcome: {
    SUCCEEDED: 'SUCCEEDED',
    FAILED: 'FAILED',
    ABORTED: 'ABORTED',
  },
  GenerationUsageTokenCountSource: {
    PROVIDER_REPORTED: 'PROVIDER_REPORTED',
    ESTIMATED: 'ESTIMATED',
    UNKNOWN: 'UNKNOWN',
  },
  Prisma: {
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));


jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));


jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-123'),
}));


jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
  verify: jest.fn(),
}));

beforeEach(() => {
    mockPrisma.$queryRaw.mockClear();
    mockPrisma.$executeRaw.mockClear();
    mockPrisma.$transaction.mockClear();
    mockPrisma.user.create.mockClear();
    mockPrisma.user.findUnique.mockClear();
    mockPrisma.user.findMany.mockClear();
    mockPrisma.user.update.mockClear();
    mockPrisma.user.count.mockClear();
    mockPrisma.chatSession.create.mockClear();
    mockPrisma.chatSession.findUnique.mockClear();
    mockPrisma.chatSession.findFirst.mockClear();
    mockPrisma.chatSession.findMany.mockClear();
    mockPrisma.chatSession.update.mockClear();
    mockPrisma.chatSession.updateMany.mockClear();
    mockPrisma.chatSession.delete.mockClear();
    mockPrisma.chatSession.deleteMany.mockClear();
    mockPrisma.chatMessage.create.mockClear();
    mockPrisma.chatMessage.findUnique.mockClear();
    mockPrisma.chatMessage.findMany.mockClear();
    mockPrisma.chatMessage.update.mockClear();
    mockPrisma.chatMessage.delete.mockClear();
    mockPrisma.llmProviderConfig.create.mockClear();
    mockPrisma.llmProviderConfig.findUnique.mockClear();
    mockPrisma.llmProviderConfig.findMany.mockClear();
    mockPrisma.llmProviderConfig.update.mockClear();
    mockPrisma.llmProviderConfig.count.mockClear();
    mockPrisma.workspace.create.mockClear();
    mockPrisma.workspace.findFirst.mockClear();
    mockPrisma.workspace.findMany.mockClear();
    mockPrisma.workspace.update.mockClear();
    mockPrisma.workspace.count.mockClear();
    mockPrisma.workspaceMembership.create.mockClear();
    mockPrisma.workspaceMembership.findFirst.mockClear();
    mockPrisma.workspaceMembership.findUnique.mockClear();
    mockPrisma.workspaceMembership.update.mockClear();
    mockPrisma.workspaceMembership.count.mockClear();
    mockPrisma.job.create.mockClear();
    mockPrisma.job.findUnique.mockClear();
    mockPrisma.job.findFirst.mockClear();
    mockPrisma.job.findMany.mockClear();
    mockPrisma.job.update.mockClear();
    mockPrisma.job.count.mockClear();
    mockPrisma.generationUsage.create.mockClear();
    mockPrisma.generationUsage.findMany.mockClear();
    mockPrisma.generationUsage.count.mockClear();
});

export { mockPrisma };
