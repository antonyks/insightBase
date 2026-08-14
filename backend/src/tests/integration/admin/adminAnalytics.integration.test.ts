import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import {
  GenerationUsageOutcome,
  GenerationUsageTokenCountSource,
  JobMetricOutcome,
  JobStatus,
  LlmProviderConfigType,
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
