import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import {
  GenerationUsageOutcome,
  GenerationUsageTokenCountSource,
  JobMetricOutcome,
  JobStatus,
  LlmProviderConfigType,
  MessageAuthor,
  ProviderHealthSampleOperation,
  ProviderHealthSampleStatus,
  UserRole,
} from '@prisma/client';
import app from '../../../app';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startTestServer(): Promise<TestServer> {
  const server = await new Promise<Server>((resolve, reject) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => {
      listeningServer.off('error', reject);
      resolve(listeningServer);
    });
    listeningServer.once('error', reject);
  });
  const address = server.address();

  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Failed to bind integration test API server.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function signToken(user: Awaited<ReturnType<typeof createIntegrationTestUser>>): string {
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

async function createAdminHeaders(): Promise<Record<string, string>> {
  const admin = await createIntegrationTestUser({ role: UserRole.ADMIN });
  const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(admin.id);

  return {
    authorization: `Bearer ${signToken(admin)}`,
    'x-workspace-id': String(workspace.id),
    'content-type': 'application/json',
  };
}

async function requestJson<T = unknown>(
  server: TestServer,
  path: string,
  init: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${server.baseUrl}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as T : undefined as T,
  };
}

beforeEach(async () => {
  await resetIntegrationDatabase();
});

describe('Admin analytics integration', () => {
  it('returns privacy-safe system-wide aggregates and honors optional date windows', async () => {
    const server = await startTestServer();

    try {
      const headers = await createAdminHeaders();
      const owner = await createIntegrationTestUser();
      const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(owner.id);
      const provider = await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Analytics Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: 'https://secret-provider.example.com',
          enabled: true,
          defaultModel: 'analytics-model',
          apiKey: 'analytics-secret-api-key',
        },
      });
      const inWindow = new Date('2026-08-14T12:00:00.000Z');
      const outsideWindow = new Date('2026-08-13T12:00:00.000Z');
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: workspace.id,
          createdByUserId: owner.id,
          type: 'validation.analytics',
          status: JobStatus.SUCCEEDED,
          progress: 100,
          stage: 'completed',
          payload: { secretPayload: 'private-job-payload' },
          result: { secretResult: 'private-job-result' },
        },
      });

      await integrationPrisma.generationUsage.createMany({
        data: [
          {
            workspaceId: workspace.id,
            providerId: provider.id,
            model: 'analytics-model',
            streaming: false,
            latencyMs: 100,
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
            outcome: GenerationUsageOutcome.SUCCEEDED,
            createdAt: inWindow,
          },
          {
            workspaceId: workspace.id,
            providerId: provider.id,
            model: 'analytics-model',
            streaming: true,
            outcome: GenerationUsageOutcome.FAILED,
            tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
            errorCode: 'SECRET_FREE_ERROR',
            createdAt: outsideWindow,
          },
        ],
      });
      await integrationPrisma.jobMetric.create({
        data: {
          jobId: job.id,
          workspaceId: workspace.id,
          jobType: 'validation.analytics',
          outcome: JobMetricOutcome.SUCCEEDED,
          attempts: 1,
          queueWaitMs: 50,
          executionDurationMs: 250,
          createdAt: inWindow,
        },
      });
      await integrationPrisma.providerHealthSample.createMany({
        data: [
          {
            providerId: provider.id,
            providerType: provider.type,
            operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
            status: ProviderHealthSampleStatus.SUCCESS,
            latencyMs: 25,
            modelCount: 1,
            createdAt: inWindow,
          },
          {
            providerId: provider.id,
            providerType: provider.type,
            operation: ProviderHealthSampleOperation.PROVIDER_TEST,
            status: ProviderHealthSampleStatus.ERROR,
            latencyMs: 1000,
            errorCode: 'OUTSIDE_WINDOW',
            createdAt: outsideWindow,
          },
        ],
      });

      const response = await requestJson<{ data: Record<string, unknown> }>(
        server,
        '/api/admin/analytics/summary?from=2026-08-14T00%3A00%3A00.000Z&to=2026-08-15T00%3A00%3A00.000Z',
        { method: 'GET', headers },
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        period: {
          from: '2026-08-14T00:00:00.000Z',
          to: '2026-08-15T00:00:00.000Z',
        },
        generation: {
          total: 1,
          succeeded: 1,
          failed: 0,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
        jobs: {
          total: 1,
          current: {
            succeeded: 1,
          },
          finalized: {
            total: 1,
            succeeded: 1,
          },
          averageQueueWaitMs: 50,
          averageExecutionDurationMs: 250,
        },
        providerHealth: {
          total: 1,
          success: 1,
          error: 0,
          latestSampleAt: '2026-08-14T12:00:00.000Z',
        },
      });
      const responseText = JSON.stringify(response.body);
      expect(responseText).not.toContain('private-job-payload');
      expect(responseText).not.toContain('private-job-result');
      expect(responseText).not.toContain('analytics-secret-api-key');
      expect(responseText).not.toContain('secret-provider.example.com');
      expect(responseText).not.toContain('OUTSIDE_WINDOW');
    } finally {
      await server.close();
    }
  });

  it('keeps analytics aggregate-only and isolates private workspace content from admins', async () => {
    const server = await startTestServer();

    try {
      const headers = await createAdminHeaders();
      const firstOwner = await createIntegrationTestUser({
        email: 'analytics-privacy-owner-a@example.com',
        name: 'analytics-private-owner-a',
      });
      const secondOwner = await createIntegrationTestUser({
        email: 'analytics-privacy-owner-b@example.com',
        name: 'analytics-private-owner-b',
      });
      const { workspace: firstWorkspace } =
        await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(firstOwner.id);
      const { workspace: secondWorkspace } =
        await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(secondOwner.id);
      const provider = await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Analytics Privacy Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: 'https://analytics-private-provider.example.com',
          enabled: true,
          defaultModel: 'analytics-private-model',
          apiKey: 'analytics-private-api-key',
          extraHeaders: {
            'X-Analytics-Secret': 'analytics-private-extra-header',
          },
        },
      });
      const privateCanaries = [
        'private-workspace-title-a',
        'private-workspace-title-b',
        'private-user-prompt-a',
        'private-user-prompt-b',
        'private-assistant-answer-a',
        'private-assistant-answer-b',
        'private-reasoning-a',
        'private-stop-sequence',
        'private-job-payload-value-a',
        'private-job-result-value-a',
        'private-job-payload-value-b',
        'private-job-result-value-b',
        'analytics-private-provider.example.com',
        'analytics-private-api-key',
        'analytics-private-extra-header',
        'private-provider-raw-error',
      ];
      const firstSession = await integrationPrisma.chatSession.create({
        data: {
          title: 'private-workspace-title-a',
          userId: firstOwner.id,
          workspaceId: firstWorkspace.id,
        },
      });
      const secondSession = await integrationPrisma.chatSession.create({
        data: {
          title: 'private-workspace-title-b',
          userId: secondOwner.id,
          workspaceId: secondWorkspace.id,
        },
      });

      await integrationPrisma.chatMessage.createMany({
        data: [
          {
            sessionId: firstSession.id,
            author: MessageAuthor.USER,
            content: 'private-user-prompt-a',
          },
          {
            sessionId: firstSession.id,
            author: MessageAuthor.ASSISTANT,
            content: 'private-assistant-answer-a',
            metadata: {
              reasoning: 'private-reasoning-a',
              stopSequences: ['private-stop-sequence'],
            },
          },
          {
            sessionId: secondSession.id,
            author: MessageAuthor.USER,
            content: 'private-user-prompt-b',
          },
          {
            sessionId: secondSession.id,
            author: MessageAuthor.ASSISTANT,
            content: 'private-assistant-answer-b',
          },
        ],
      });
      const firstJob = await integrationPrisma.job.create({
        data: {
          workspaceId: firstWorkspace.id,
          createdByUserId: firstOwner.id,
          type: 'analytics.privacy.first',
          status: JobStatus.SUCCEEDED,
          progress: 100,
          stage: 'completed',
          payload: { privatePayload: 'private-job-payload-value-a' },
          result: { privateResult: 'private-job-result-value-a' },
          completedAt: new Date('2026-08-14T12:10:00.000Z'),
        },
      });
      const secondJob = await integrationPrisma.job.create({
        data: {
          workspaceId: secondWorkspace.id,
          createdByUserId: secondOwner.id,
          type: 'analytics.privacy.second',
          status: JobStatus.FAILED,
          progress: 100,
          stage: 'failed',
          payload: { privatePayload: 'private-job-payload-value-b' },
          result: { privateResult: 'private-job-result-value-b' },
          errorCode: 'PRIVACY_SAFE_FAILURE',
          sanitizedError: 'Job handler failed.',
          completedAt: new Date('2026-08-14T12:15:00.000Z'),
        },
      });

      await integrationPrisma.generationUsage.createMany({
        data: [
          {
            workspaceId: firstWorkspace.id,
            providerId: provider.id,
            model: 'analytics-private-model',
            streaming: false,
            latencyMs: 110,
            inputTokens: 5,
            outputTokens: 7,
            totalTokens: 12,
            tokenCountSource: GenerationUsageTokenCountSource.PROVIDER_REPORTED,
            outcome: GenerationUsageOutcome.SUCCEEDED,
          },
          {
            workspaceId: secondWorkspace.id,
            providerId: provider.id,
            model: 'analytics-private-model',
            streaming: true,
            latencyMs: 220,
            tokenCountSource: GenerationUsageTokenCountSource.UNKNOWN,
            outcome: GenerationUsageOutcome.FAILED,
            errorCode: 'PRIVATE_CONTENT_FREE_ERROR',
          },
        ],
      });
      await integrationPrisma.jobMetric.createMany({
        data: [
          {
            jobId: firstJob.id,
            workspaceId: firstWorkspace.id,
            jobType: firstJob.type,
            outcome: JobMetricOutcome.SUCCEEDED,
            attempts: 1,
            queueWaitMs: 10,
            executionDurationMs: 20,
          },
          {
            jobId: secondJob.id,
            workspaceId: secondWorkspace.id,
            jobType: secondJob.type,
            outcome: JobMetricOutcome.FAILED,
            attempts: 1,
            queueWaitMs: 15,
            executionDurationMs: 25,
            errorCode: 'PRIVATE_CONTENT_FREE_ERROR',
          },
        ],
      });
      await integrationPrisma.providerHealthSample.create({
        data: {
          providerId: provider.id,
          providerType: provider.type,
          operation: ProviderHealthSampleOperation.MODEL_REGISTRY,
          status: ProviderHealthSampleStatus.ERROR,
          latencyMs: 30,
          modelCount: 0,
          errorCode: 'HTTP_500',
        },
      });

      const response = await requestJson<{ data: Record<string, unknown> }>(
        server,
        '/api/admin/analytics/summary',
        { method: 'GET', headers },
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        generation: {
          total: 2,
          succeeded: 1,
          failed: 1,
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
        },
        jobs: {
          total: 2,
          finalized: {
            total: 2,
            succeeded: 1,
            failed: 1,
          },
        },
        providerHealth: {
          total: 1,
          error: 1,
        },
      });
      expect(response.body.data).not.toHaveProperty('workspaces');
      expect(response.body.data).not.toHaveProperty('sessions');
      expect(response.body.data).not.toHaveProperty('messages');
      expect(response.body.data).not.toHaveProperty('chat');

      const analyticsResponseText = JSON.stringify(response.body);
      for (const canary of privateCanaries) {
        expect(analyticsResponseText).not.toContain(canary);
      }

      const generationUsageRows = await integrationPrisma.generationUsage.findMany();
      const jobMetricRows = await integrationPrisma.jobMetric.findMany();
      const providerHealthRows = await integrationPrisma.providerHealthSample.findMany();
      const persistedMetricText = JSON.stringify({
        generationUsageRows,
        jobMetricRows,
        providerHealthRows,
      });
      for (const canary of privateCanaries) {
        expect(persistedMetricText).not.toContain(canary);
      }

      const analyticsChatProbe = await requestJson<{ message?: string }>(
        server,
        `/api/admin/analytics/chat-sessions/${firstSession.id}`,
        { method: 'GET', headers },
      );

      expect(analyticsChatProbe.status).toBe(404);
      const analyticsChatProbeText = JSON.stringify(analyticsChatProbe.body);
      for (const canary of privateCanaries) {
        expect(analyticsChatProbeText).not.toContain(canary);
      }
    } finally {
      await server.close();
    }
  });

  it('rejects invalid analytics date windows', async () => {
    const server = await startTestServer();

    try {
      const headers = await createAdminHeaders();
      const response = await requestJson<{ code: string }>(
        server,
        '/api/admin/analytics/summary?from=2026-08-15T00%3A00%3A00.000Z&to=2026-08-14T00%3A00%3A00.000Z',
        { method: 'GET', headers },
      );

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('ANALYTICS_PERIOD_INVALID');
    } finally {
      await server.close();
    }
  });
});
