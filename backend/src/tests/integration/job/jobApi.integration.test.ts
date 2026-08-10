import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { JobStatus, UserRole } from '@prisma/client';
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

type TestUserContext = {
  user: Awaited<ReturnType<typeof createIntegrationTestUser>>;
  workspace: Awaited<
    ReturnType<typeof WorkspaceProvisioningService.ensurePersonalWorkspaceForUser>
  >['workspace'];
  headers: Record<string, string>;
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

async function createUserContext(role = UserRole.USER): Promise<TestUserContext> {
  const user = await createIntegrationTestUser({ role });
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

beforeEach(async () => {
  await resetIntegrationDatabase();
});

describe('Job API integration', () => {
  it('returns workspace-scoped job status without internal payload or queue identifiers', async () => {
    const server = await startTestServer();

    try {
      const owner = await createUserContext();
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: owner.workspace.id,
          createdByUserId: owner.user.id,
          type: 'validation.fixture',
          payload: { operationId: 'internal-operation' },
          queueMessageId: 'pgboss-internal-message',
          result: { processedCount: 1 },
          status: JobStatus.SUCCEEDED,
          progress: 100,
          stage: 'completed',
          completedAt: new Date(),
        },
      });

      const response = await requestJson<{ data: Record<string, unknown> }>(
        server,
        `/api/jobs/${job.id}`,
        {
          method: 'GET',
          headers: owner.headers,
        },
      );

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        id: job.id,
        workspaceId: owner.workspace.id,
        status: JobStatus.SUCCEEDED,
        result: { processedCount: 1 },
      });
      expect(response.body.data).not.toHaveProperty('payload');
      expect(response.body.data).not.toHaveProperty('queueMessageId');
      expect(JSON.stringify(response.body)).not.toContain('pgboss-internal-message');
      expect(JSON.stringify(response.body)).not.toContain('internal-operation');
    } finally {
      await server.close();
    }
  });

  it('rejects cross-workspace job reads and cancellation', async () => {
    const server = await startTestServer();

    try {
      const owner = await createUserContext();
      const otherUser = await createUserContext();
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: owner.workspace.id,
          createdByUserId: owner.user.id,
          type: 'validation.fixture',
        },
      });

      const readResponse = await requestJson(server, `/api/jobs/${job.id}`, {
        method: 'GET',
        headers: otherUser.headers,
      });
      const cancelResponse = await requestJson(server, `/api/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: otherUser.headers,
      });

      expect(readResponse.status).toBe(404);
      expect(cancelResponse.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('requests cancellation idempotently for active jobs and leaves terminal jobs unchanged', async () => {
    const server = await startTestServer();

    try {
      const owner = await createUserContext();
      const runningJob = await integrationPrisma.job.create({
        data: {
          workspaceId: owner.workspace.id,
          createdByUserId: owner.user.id,
          type: 'validation.fixture',
          status: JobStatus.RUNNING,
          stage: 'running',
          startedAt: new Date(),
        },
      });
      const terminalJob = await integrationPrisma.job.create({
        data: {
          workspaceId: owner.workspace.id,
          createdByUserId: owner.user.id,
          type: 'validation.fixture',
          status: JobStatus.SUCCEEDED,
          progress: 100,
          stage: 'completed',
          completedAt: new Date(),
        },
      });

      const firstCancel = await requestJson<{ data: Record<string, unknown> }>(
        server,
        `/api/jobs/${runningJob.id}/cancel`,
        {
          method: 'POST',
          headers: owner.headers,
        },
      );
      const secondCancel = await requestJson<{ data: Record<string, unknown> }>(
        server,
        `/api/jobs/${runningJob.id}/cancel`,
        {
          method: 'POST',
          headers: owner.headers,
        },
      );
      const terminalCancel = await requestJson<{ data: Record<string, unknown> }>(
        server,
        `/api/jobs/${terminalJob.id}/cancel`,
        {
          method: 'POST',
          headers: owner.headers,
        },
      );

      expect(firstCancel.status).toBe(200);
      expect(secondCancel.status).toBe(200);
      expect(firstCancel.body.data).toMatchObject({
        status: JobStatus.CANCEL_REQUESTED,
        stage: 'cancellation_requested',
      });
      expect(secondCancel.body.data).toMatchObject({
        status: JobStatus.CANCEL_REQUESTED,
      });
      expect(terminalCancel.body.data).toMatchObject({
        status: JobStatus.SUCCEEDED,
        stage: 'completed',
      });
    } finally {
      await server.close();
    }
  });

  it('streams an immediate snapshot and terminal state from durable job data', async () => {
    const server = await startTestServer();

    try {
      const owner = await createUserContext();
      const job = await integrationPrisma.job.create({
        data: {
          workspaceId: owner.workspace.id,
          createdByUserId: owner.user.id,
          type: 'validation.fixture',
          payload: { operationId: 'stream-internal-operation' },
          queueMessageId: 'stream-internal-message',
          status: JobStatus.FAILED,
          stage: 'failed',
          errorCode: 'VALIDATION_FAILED',
          sanitizedError: 'Validation failed.',
          completedAt: new Date(),
        },
      });

      const response = await fetch(`${server.baseUrl}/api/jobs/${job.id}/stream`, {
        method: 'GET',
        headers: owner.headers,
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(body).toContain('event: snapshot\n');
      expect(body).toContain('event: failed\n');
      expect(body).toContain('"status":"FAILED"');
      expect(body).not.toContain('stream-internal-message');
      expect(body).not.toContain('stream-internal-operation');
    } finally {
      await server.close();
    }
  });
});
