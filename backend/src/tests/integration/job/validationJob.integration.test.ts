import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { JobStatus, UserRole } from '@prisma/client';
import app from '../../../app';
import { ENV } from '../../../config/env';
import {
  createJobWorkerHandler,
  ensurePgBossQueue,
  JobService,
} from '../../../modules/job';
import {
  createValidationJobHandler,
  createWorkerCpuTaskPool,
  VALIDATION_JOB_QUEUE,
  VALIDATION_JOB_TYPE,
} from '../../../modules/worker';
import {
  getJobQueueTransport,
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
  it('keeps validation jobs workspace-scoped across read, cancel and stream APIs', async () => {
    const server = await startTestServer();

    try {
      const owner = await createAdminContext();
      const other = await createAdminContext();
      const response = await requestJson<{ data: { id: number } }>(
        server,
        '/api/admin/system/validation-jobs',
        {
          method: 'POST',
          headers: owner.headers,
          body: JSON.stringify({ mode: 'success' }),
        },
      );

      expect(response.status).toBe(202);
      await expect(requestJson(server, `/api/jobs/${response.body.data.id}`, {
        method: 'GET',
        headers: other.headers,
      })).resolves.toMatchObject({ status: 404 });
      await expect(requestJson(server, `/api/jobs/${response.body.data.id}/cancel`, {
        method: 'POST',
        headers: other.headers,
      })).resolves.toMatchObject({ status: 404 });

      const streamResponse = await fetch(`${server.baseUrl}/api/jobs/${response.body.data.id}/stream`, {
        method: 'GET',
        headers: other.headers,
      });

      expect(streamResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });

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
      await expect(requestJson<{ data: { status: JobStatus } }>(
        server,
        `/api/jobs/${response.body.data.id}/cancel`,
        {
          method: 'POST',
          headers: admin.headers,
        },
      )).resolves.toMatchObject({
        status: 200,
        body: {
          data: {
            status: JobStatus.CANCEL_REQUESTED,
          },
        },
      });

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

  it('streams a reconnect snapshot from durable in-progress job state', async () => {
    const server = await startTestServer();

    try {
      const admin = await createAdminContext();
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: admin.workspace.id,
          createdByUserId: admin.user.id,
          type: VALIDATION_JOB_TYPE,
          payload: { mode: 'success' },
          queueMessageId: 'in-progress-message-id',
          status: JobStatus.RUNNING,
          progress: 55,
          stage: 'validation_checksum_complete',
          attempts: 1,
          startedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      const abortController = new AbortController();
      const response = await fetch(`${server.baseUrl}/api/jobs/${job.id}/stream`, {
        method: 'GET',
        headers: admin.headers,
        signal: abortController.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected SSE response body.');

      try {
        const snapshot = await readUntil(
          reader,
          (text) =>
            text.includes('event: snapshot\n') &&
            text.includes('"progress":55') &&
            text.includes('"stage":"validation_checksum_complete"'),
        );

        expect(response.status).toBe(200);
        expect(snapshot).not.toContain('in-progress-message-id');
      } finally {
        abortController.abort();
      }
    } finally {
      await server.close();
    }
  });

  it('recovers a stale non-final running validation job by requeueing and completing it', async () => {
    const worker = await startValidationWorker();

    try {
      const admin = await createAdminContext();
      const staleHeartbeat = new Date('2026-01-01T00:00:00.000Z');
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: admin.workspace.id,
          createdByUserId: admin.user.id,
          type: VALIDATION_JOB_TYPE,
          payload: { mode: 'success' },
          queueMessageId: 'stale-message-id',
          status: JobStatus.RUNNING,
          stage: 'running',
          attempts: 1,
          maxAttempts: 3,
          startedAt: staleHeartbeat,
          heartbeatAt: staleHeartbeat,
        },
      });

      await expect(JobService.recoverStaleRunningJobs(
        getJobQueueTransport(),
        {
          staleJobMs: 1000,
          now: new Date('2026-01-01T00:01:00.000Z'),
        },
      )).resolves.toEqual({ skipped: false, scanned: 1, requeued: 1, failed: 0 });

      const requeued = await integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(requeued).toMatchObject({
        status: JobStatus.QUEUED,
        stage: 'stale_requeued',
        attempts: 1,
      });
      expect(requeued.queueMessageId).not.toBe('stale-message-id');

      const completed = await waitForJobStatus(job.id, [JobStatus.SUCCEEDED]);
      expect(completed).toMatchObject({
        status: JobStatus.SUCCEEDED,
        attempts: 2,
        result: {
          mode: 'success',
          checksum: EXPECTED_CHECKSUM,
          iterations: 25000,
          seedLength: 22,
        },
      });
    } finally {
      await worker.close();
    }
  });

  it('marks exhausted stale running validation jobs failed with sanitized stale error', async () => {
    const admin = await createAdminContext();
    const staleHeartbeat = new Date('2026-01-01T00:00:00.000Z');
    const job = await integrationPrisma.job.create({
      data: {
        workspaceId: admin.workspace.id,
        createdByUserId: admin.user.id,
        type: VALIDATION_JOB_TYPE,
        payload: { mode: 'success' },
        queueMessageId: 'exhausted-stale-message-id',
        status: JobStatus.RUNNING,
        stage: 'running',
        attempts: 2,
        maxAttempts: 2,
        startedAt: staleHeartbeat,
        heartbeatAt: staleHeartbeat,
      },
    });

    await expect(JobService.recoverStaleRunningJobs(
      getJobQueueTransport(),
      {
        staleJobMs: 1000,
        now: new Date('2026-01-01T00:01:00.000Z'),
      },
    )).resolves.toEqual({ skipped: false, scanned: 1, requeued: 0, failed: 1 });

    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.FAILED,
      stage: 'failed',
      attempts: 2,
      maxAttempts: 2,
      errorCode: 'JOB_WORKER_STALE',
      sanitizedError: 'Job worker became stale.',
    });
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

  it('keeps terminal validation job states immutable across runtime operations', async () => {
    const admin = await createAdminContext();
    const now = new Date();
    const succeeded = await integrationPrisma.job.create({
      data: {
        workspaceId: admin.workspace.id,
        createdByUserId: admin.user.id,
        type: VALIDATION_JOB_TYPE,
        status: JobStatus.SUCCEEDED,
        progress: 100,
        stage: 'completed',
        completedAt: now,
      },
    });
    const failed = await integrationPrisma.job.create({
      data: {
        workspaceId: admin.workspace.id,
        createdByUserId: admin.user.id,
        type: VALIDATION_JOB_TYPE,
        status: JobStatus.FAILED,
        stage: 'failed',
        errorCode: 'EXISTING_FAILURE',
        sanitizedError: 'Existing failure.',
        completedAt: now,
      },
    });
    const cancelled = await integrationPrisma.job.create({
      data: {
        workspaceId: admin.workspace.id,
        createdByUserId: admin.user.id,
        type: VALIDATION_JOB_TYPE,
        status: JobStatus.CANCELLED,
        stage: 'cancelled',
        completedAt: now,
      },
    });

    await expect(JobService.requestCancellation(succeeded.id)).resolves.toMatchObject({
      status: JobStatus.SUCCEEDED,
    });
    await expect(JobService.markSucceeded(failed.id, { ignored: true })).resolves.toMatchObject({
      status: JobStatus.FAILED,
      errorCode: 'EXISTING_FAILURE',
    });
    await expect(JobService.markFailed(cancelled.id, 'IGNORED', 'Ignored.')).resolves.toMatchObject({
      status: JobStatus.CANCELLED,
      sanitizedError: null,
    });
    await expect(JobService.recoverStaleRunningJobs(
      getJobQueueTransport(),
      {
        staleJobMs: 1,
        now: new Date('2026-01-01T00:01:00.000Z'),
      },
    )).resolves.toEqual({ skipped: false, scanned: 0, requeued: 0, failed: 0 });
    await expect(JobService.reconcileQueuedJobsWithoutQueueMessage(
      getJobQueueTransport(),
    )).resolves.toEqual({ skipped: false, scanned: 0, reenqueued: 0, failed: 0 });

    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: succeeded.id } }),
    ).resolves.toMatchObject({ status: JobStatus.SUCCEEDED, stage: 'completed' });
    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: failed.id } }),
    ).resolves.toMatchObject({
      status: JobStatus.FAILED,
      errorCode: 'EXISTING_FAILURE',
      sanitizedError: 'Existing failure.',
    });
    await expect(
      integrationPrisma.job.findUniqueOrThrow({ where: { id: cancelled.id } }),
    ).resolves.toMatchObject({ status: JobStatus.CANCELLED, stage: 'cancelled' });
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const result = await reader.read();
    if (result.done) break;

    text += decoder.decode(result.value, { stream: true });
    if (predicate(text)) return text;
  }

  throw new Error(`Timed out waiting for SSE text. Received: ${text}`);
}
