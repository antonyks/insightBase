import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { JobStatus, UserRole } from '@prisma/client';
import app from '../../../app';
import { ENV } from '../../../config/env';
import {
  createJobWorkerHandler,
  ensurePgBossQueue,
} from '../../../modules/job';
import {
  createValidationJobHandler,
  createWorkerCpuTaskPool,
  VALIDATION_JOB_QUEUE,
  VALIDATION_JOB_TYPE,
} from '../../../modules/worker';
import {
  startJobQueueClient,
  stopJobQueueClient,
} from '../../../modules/job/jobQueue.client';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';

const EXPECTED_CHECKSUM = 'cec28d83362a96f97751981f0db822a82eb53043fb1abb75039ac76cfbee7483';

type TestServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

type TestUserContext = {
  user: Awaited<ReturnType<typeof createIntegrationTestUser>>;
  workspace: Awaited<
    ReturnType<typeof WorkspaceProvisioningService.ensurePersonalWorkspaceForUser>
  >['workspace'];
  headers: Record<string, string>;
};

type ValidationWorker = {
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

function signToken(user: TestUserContext['user']): string {
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

async function createAdminContext(): Promise<TestUserContext> {
  const user = await createIntegrationTestUser({ role: UserRole.ADMIN });
  const { workspace } = await WorkspaceProvisioningService.ensurePersonalWorkspaceForUser(user.id);

  return {
    user,
    workspace,
    headers: {
      authorization: `Bearer ${signToken(user)}`,
      'x-workspace-id': String(workspace.id),
      'content-type': 'application/json',
    },
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

async function startValidationWorker(): Promise<ValidationWorker> {
  const { PgBoss } = await importPgBoss();
  const boss = new PgBoss({
    connectionString: ENV.DATABASE_URL,
    schema: ENV.PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  const cpuTaskPool = createWorkerCpuTaskPool({ threadCount: 1 });

  await boss.start();
  await ensurePgBossQueue(boss, VALIDATION_JOB_QUEUE);
  await boss.work(
    VALIDATION_JOB_QUEUE,
    {
      includeMetadata: true,
      localConcurrency: 1,
      pollingInterval: 100,
      notifyPollingInterval: 100,
    },
    createJobWorkerHandler(
      createValidationJobHandler(cpuTaskPool),
      {
        boss,
        heartbeatIntervalMs: 100,
      },
    ),
  );

  return {
    close: async () => {
      await boss.stop({ graceful: true, close: true, timeout: 5000 });
      await cpuTaskPool.close().catch(async () => {
        await cpuTaskPool.destroy();
      });
    },
  };
}

async function clearValidationQueue(): Promise<void> {
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
    await boss.deleteAllJobs(VALIDATION_JOB_QUEUE).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('does not exist')) {
        return;
      }

      throw error;
    });
  } finally {
    await boss.stop({ graceful: true, close: true, timeout: 5000 });
  }
}

async function importPgBoss(): Promise<typeof import('pg-boss')> {
  const dynamicImport = new Function('moduleName', 'return import(moduleName)') as
    (moduleName: string) => Promise<typeof import('pg-boss')>;

  return dynamicImport('pg-boss');
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
  await stopJobQueueClient().catch(() => undefined);
  await clearValidationQueue();
  await startJobQueueClient();
});

afterEach(async () => {
  await stopJobQueueClient().catch(() => undefined);
});

describe('validation job integration', () => {
  it('enqueues through the admin API and succeeds through pg-boss, worker pickup and Piscina', async () => {
    const server = await startTestServer();
    const worker = await startValidationWorker();

    try {
      const admin = await createAdminContext();
      const response = await requestJson<{ data: { id: number; type: string; status: JobStatus } }>(
        server,
        '/api/admin/system/validation-jobs',
        {
          method: 'POST',
          headers: admin.headers,
          body: JSON.stringify({ mode: 'success' }),
        },
      );

      expect(response.status).toBe(202);
      expect(response.body.data).toMatchObject({
        type: VALIDATION_JOB_TYPE,
        status: JobStatus.QUEUED,
      });

      const completedJob = await waitForJobStatus(response.body.data.id, [JobStatus.SUCCEEDED]);
      expect(completedJob).toMatchObject({
        status: JobStatus.SUCCEEDED,
        progress: 100,
        stage: 'completed',
        attempts: 1,
        result: {
          mode: 'success',
          checksum: EXPECTED_CHECKSUM,
          iterations: 25000,
          seedLength: 22,
        },
      });
      expect(completedJob.heartbeatAt).not.toBeNull();
      expect(completedJob.queueMessageId).not.toBeNull();
    } finally {
      await worker.close();
      await server.close();
    }
  });

  it('forces retry and final sanitized failure without LLM or RAG dependencies', async () => {
    const server = await startTestServer();
    const worker = await startValidationWorker();

    try {
      const admin = await createAdminContext();
      const response = await requestJson<{ data: { id: number } }>(
        server,
        '/api/admin/system/validation-jobs',
        {
          method: 'POST',
          headers: admin.headers,
          body: JSON.stringify({ mode: 'fail' }),
        },
      );

      expect(response.status).toBe(202);
      const failedJob = await waitForJobStatus(response.body.data.id, [JobStatus.FAILED], 20000);

      expect(failedJob).toMatchObject({
        status: JobStatus.FAILED,
        stage: 'failed',
        attempts: 2,
        maxAttempts: 2,
        errorCode: 'JOB_HANDLER_FAILED',
        sanitizedError: 'Job handler failed.',
      });
      expect(JSON.stringify(failedJob)).not.toContain('forced failure');
    } finally {
      await worker.close();
      await server.close();
    }
  });

  it('cancels through the existing job API before worker pickup', async () => {
    const server = await startTestServer();
    let worker: ValidationWorker | undefined;

    try {
      const admin = await createAdminContext();
      const response = await requestJson<{ data: { id: number } }>(
        server,
        '/api/admin/system/validation-jobs',
        {
          method: 'POST',
          headers: admin.headers,
          body: JSON.stringify({ mode: 'success' }),
        },
      );
      expect(response.status).toBe(202);

      const cancelResponse = await requestJson<{ data: { status: JobStatus } }>(
        server,
        `/api/jobs/${response.body.data.id}/cancel`,
        {
          method: 'POST',
          headers: admin.headers,
        },
      );
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body.data.status).toBe(JobStatus.CANCEL_REQUESTED);

      worker = await startValidationWorker();
      const cancelledJob = await waitForJobStatus(response.body.data.id, [JobStatus.CANCELLED]);

      expect(cancelledJob).toMatchObject({
        status: JobStatus.CANCELLED,
        stage: 'cancelled',
        attempts: 0,
      });
    } finally {
      await worker?.close();
      await server.close();
    }
  });

  it('reports validation job terminal state through existing SSE endpoint', async () => {
    const server = await startTestServer();

    try {
      const admin = await createAdminContext();
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: admin.workspace.id,
          createdByUserId: admin.user.id,
          type: VALIDATION_JOB_TYPE,
          payload: { mode: 'success' },
          queueMessageId: 'sse-message-id',
          status: JobStatus.SUCCEEDED,
          progress: 100,
          stage: 'completed',
          result: {
            mode: 'success',
            checksum: EXPECTED_CHECKSUM,
          },
          completedAt: new Date(),
        },
      });

      const response = await fetch(`${server.baseUrl}/api/jobs/${job.id}/stream`, {
        method: 'GET',
        headers: admin.headers,
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(body).toContain('event: snapshot\n');
      expect(body).toContain('event: succeeded\n');
      expect(body).toContain('"status":"SUCCEEDED"');
      expect(body).toContain(EXPECTED_CHECKSUM);
      expect(body).not.toContain('sse-message-id');
    } finally {
      await server.close();
    }
  });
});
