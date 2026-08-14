import { MessageAuthor, PrismaClient, type Prisma, UserRole, UserStatus } from '@prisma/client';

export const integrationPrisma = new PrismaClient();

const tablesToReset = [
  'provider_health_samples',
  'job_metrics',
  'generation_usages',
  'jobs',
  'workspace_memberships',
  'workspaces',
  'chat_messages',
  'chat_sessions',
  'llm_provider_configs',
  'users',
];

export async function resetIntegrationDatabase(): Promise<void> {
  await integrationPrisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tablesToReset.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export async function createIntegrationTestUser(
  overrides: Partial<Prisma.UserCreateInput> = {},
) {
  const uniqueValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return integrationPrisma.user.create({
    data: {
      email: `integration-${uniqueValue}@example.com`,
      name: 'Integration Test User',
      passwordHash: 'integration-test-password-hash',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
      ...overrides,
    },
  });
}

export async function createIntegrationChatSession(
  userId: number,
  overrides: Partial<Omit<Prisma.ChatSessionCreateInput, 'workspace'>> &
    Pick<Prisma.ChatSessionCreateInput, 'workspace'>,
) {
  return integrationPrisma.chatSession.create({
    data: {
      title: 'Integration Test Chat',
      user: {
        connect: { id: userId },
      },
      ...overrides,
    },
  });
}

export async function createIntegrationChatMessage(
  sessionId: number,
  overrides: Partial<Prisma.ChatMessageCreateInput> = {},
) {
  return integrationPrisma.chatMessage.create({
    data: {
      content: 'Integration test message',
      author: MessageAuthor.USER,
      session: {
        connect: { id: sessionId },
      },
      ...overrides,
    },
  });
}
