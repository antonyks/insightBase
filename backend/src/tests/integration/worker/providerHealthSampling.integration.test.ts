import { JobStatus, LlmProviderConfigType, ProviderHealthSampleStatus, UserRole } from '@prisma/client';
import { ENV } from '../../../config/env';
import {
  createJobWorkerHandler,
  ensurePgBossQueue,
  PgBossJobQueueTransport,
} from '../../../modules/job';
import {
  createProviderHealthSamplingJobHandler,
  enqueueProviderHealthSamplingJob,
  PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
  PROVIDER_HEALTH_SAMPLING_JOB_TYPE,
} from '../../../modules/worker/providerHealthSamplingJob';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';
import { createMockLlmUpstream, sendJson } from '../helpers/mockLlmUpstream';

type ProviderHealthSamplingWorker = {
  close: () => Promise<void>;
};

async function importPgBoss(): Promise<typeof import('pg-boss')> {
  const dynamicImport = new Function('moduleName', 'return import(moduleName)') as
    (moduleName: string) => Promise<typeof import('pg-boss')>;

  return dynamicImport('pg-boss');
}

async function startProviderHealthSamplingWorker(): Promise<{
  worker: ProviderHealthSamplingWorker;
  queueTransport: PgBossJobQueueTransport;
}> {
  const { PgBoss } = await importPgBoss();
  const boss = new PgBoss({
    connectionString: ENV.DATABASE_URL,
    schema: ENV.PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });

  await boss.start();
  await ensurePgBossQueue(boss, PROVIDER_HEALTH_SAMPLING_JOB_QUEUE);
  await boss.work(
    PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
    {
      includeMetadata: true,
      localConcurrency: 1,
      pollingInterval: 100,
      notifyPollingInterval: 100,
    },
    createJobWorkerHandler(
      createProviderHealthSamplingJobHandler(),
      {
        boss,
        heartbeatIntervalMs: 100,
      },
    ),
  );

  return {
    queueTransport: new PgBossJobQueueTransport(boss),
    worker: {
      close: async () => {
        await boss.stop({ graceful: true, close: true, timeout: 5000 });
      },
    },
  };
}

async function clearProviderHealthSamplingQueue(): Promise<void> {
  const { PgBoss } = await importPgBoss();
  const boss = new PgBoss({
    connectionString: ENV.DATABASE_URL,
    schema: ENV.PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });

  await boss.start();
  try {
    await boss.deleteAllJobs(PROVIDER_HEALTH_SAMPLING_JOB_QUEUE).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('does not exist')) {
        return;
      }

      throw error;
    });
  } finally {
    await boss.stop({ graceful: true, close: true, timeout: 5000 });
  }
}

async function waitForJobStatus(
  jobId: number,
  statuses: JobStatus[],
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await integrationPrisma.job.findUniqueOrThrow({ where: { id: jobId } });
    if (statuses.includes(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for job ${jobId} to reach ${statuses.join(',')}.`);
}

beforeEach(async () => {
  await resetIntegrationDatabase();
  await clearProviderHealthSamplingQueue();
});

describe('provider health sampling worker integration', () => {
  it('runs as a durable job and records sanitized samples for active providers only', async () => {
    const successUpstream = await createMockLlmUpstream({
      'GET /models': (_request, response) => {
        sendJson(response, 200, {
          object: 'list',
          data: [{ id: 'sample-model', object: 'model' }],
        });
      },
    });
    const errorUpstream = await createMockLlmUpstream({
      'GET /models': (_request, response) => {
        sendJson(response, 500, {
          error: { message: 'secret raw provider failure' },
        });
      },
    });
    const { worker, queueTransport } = await startProviderHealthSamplingWorker();

    try {
      const admin = await createIntegrationTestUser({ role: UserRole.ADMIN });
      await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(admin.id);

      const activeSuccessProvider = await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Active Success Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: successUpstream.baseUrl,
          enabled: true,
          defaultModel: 'sample-model',
          apiKey: 'active-success-secret-api-key',
          extraHeaders: { authorization: 'secret-extra-header' },
        },
      });
      const activeErrorProvider = await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Active Error Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: errorUpstream.baseUrl,
          enabled: true,
          defaultModel: 'sample-model',
          apiKey: 'active-error-secret-api-key',
        },
      });
      await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Disabled Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: successUpstream.baseUrl,
          enabled: false,
          defaultModel: 'sample-model',
          apiKey: 'disabled-secret-api-key',
        },
      });
      await integrationPrisma.llmProviderConfig.create({
        data: {
          name: 'Deleted Provider',
          type: LlmProviderConfigType.OPENAI_COMPATIBLE,
          baseUrl: successUpstream.baseUrl,
          enabled: true,
          defaultModel: 'sample-model',
          apiKey: 'deleted-secret-api-key',
          deletedAt: new Date(),
        },
      });

      const enqueueResult = await enqueueProviderHealthSamplingJob(queueTransport);
      expect(enqueueResult.skipped).toBe(false);
      if (enqueueResult.skipped) {
        throw new Error(`Provider health sampling enqueue skipped: ${enqueueResult.reason}`);
      }

      const completedJob = await waitForJobStatus(enqueueResult.jobId, [JobStatus.SUCCEEDED]);
      expect(completedJob.type).toBe(PROVIDER_HEALTH_SAMPLING_JOB_TYPE);
      expect(completedJob.result).toMatchObject({
        providers: 2,
        success: 1,
        error: 1,
        skipped: 0,
      });

      const samples = await integrationPrisma.providerHealthSample.findMany({
        orderBy: { providerId: 'asc' },
      });
      expect(samples).toHaveLength(2);
      expect(samples).toEqual([
        expect.objectContaining({
          providerId: activeSuccessProvider.id,
          status: ProviderHealthSampleStatus.SUCCESS,
          modelCount: 1,
          errorCode: null,
        }),
        expect.objectContaining({
          providerId: activeErrorProvider.id,
          status: ProviderHealthSampleStatus.ERROR,
          modelCount: 0,
          errorCode: 'HTTP_500',
        }),
      ]);
      expect(successUpstream.requests).toHaveLength(1);
      expect(errorUpstream.requests).toHaveLength(1);

      const persistedText = JSON.stringify({
        job: completedJob,
        samples,
      });
      expect(persistedText).not.toContain('active-success-secret-api-key');
      expect(persistedText).not.toContain('active-error-secret-api-key');
      expect(persistedText).not.toContain('disabled-secret-api-key');
      expect(persistedText).not.toContain('deleted-secret-api-key');
      expect(persistedText).not.toContain('secret-extra-header');
      expect(persistedText).not.toContain('secret raw provider failure');
    } finally {
      await worker.close();
      await successUpstream.close();
      await errorUpstream.close();
    }
  });
});
