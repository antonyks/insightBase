import { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { JobStatus, UserRole } from '@prisma/client';
import app from '../../../app';
import { getIntegrationDatabaseUrl } from '../helpers/database';
import { WorkspaceProvisioningService } from '../../../modules/workspace/workspaceProvisioning.service';
import {
  createIntegrationTestUser,
  integrationPrisma,
  resetIntegrationDatabase,
} from '../helpers/prisma';
import {
  JOB_NOTIFICATION_CHANNEL,
  jobNotificationListener,
  JobService,
} from '../../../modules/job';

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

async function createRunningJob(context: TestUserContext) {
  return integrationPrisma.job.create({
    data: {
      workspaceId: context.workspace.id,
      createdByUserId: context.user.id,
      type: 'validation.fixture',
      status: JobStatus.RUNNING,
      stage: 'running',
      startedAt: new Date(),
    },
  });
}

beforeEach(async () => {
  await resetIntegrationDatabase();
});

afterEach(async () => {
  await jobNotificationListener.close();
});

describe('Job notification integration', () => {
  it('wakes a job SSE stream through LISTEN/NOTIFY and emits durable re-read state', async () => {
    const server = await startTestServer();

    try {
      const owner = await createUserContext();
      const job = await createRunningJob(owner);
      const response = await fetch(`${server.baseUrl}/api/jobs/${job.id}/stream`, {
        method: 'GET',
        headers: owner.headers,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected SSE response body.');

      await readUntil(reader, (text) => text.includes('event: snapshot\n'));
      await JobService.updateProgress(job.id, 45, 'notified-progress');
      const progressText = await readUntil(
        reader,
        (text) =>
          text.includes('event: progress\n') &&
          text.includes('"progress":45') &&
          text.includes('"stage":"notified-progress"'),
      );
      await JobService.markSucceeded(job.id, { processedCount: 1 });
      const terminalText = await readUntil(
        reader,
        (text) => text.includes('event: succeeded\n') && text.includes('"status":"SUCCEEDED"'),
      );

      expect(response.status).toBe(200);
      expect(progressText).not.toContain('payload');
      expect(terminalText).not.toContain('queueMessageId');
    } finally {
      await server.close();
    }
  });

  it('keeps job SSE progressing through fallback polling when no notification is emitted', async () => {
    const server = await startTestServer();
    const abortController = new AbortController();

    try {
      const owner = await createUserContext();
      const job = await createRunningJob(owner);
      const response = await fetch(`${server.baseUrl}/api/jobs/${job.id}/stream`, {
        method: 'GET',
        headers: owner.headers,
        signal: abortController.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Expected SSE response body.');

      await readUntil(reader, (text) => text.includes('event: snapshot\n'));
      await integrationPrisma.job.update({
        where: { id: job.id },
        data: {
          progress: 64,
          stage: 'polling-fallback',
        },
      });
      const progressText = await readUntil(
        reader,
        (text) =>
          text.includes('event: progress\n') &&
          text.includes('"progress":64') &&
          text.includes('"stage":"polling-fallback"'),
      );

      expect(response.status).toBe(200);
      expect(progressText).toContain('"status":"RUNNING"');
    } finally {
      abortController.abort();
      await server.close();
    }
  });

  it('emits lightweight notification payloads without workspace or job private data', async () => {
    const listener = new Client({ connectionString: getIntegrationDatabaseUrl() });
    await listener.connect();

    try {
      await listener.query(`LISTEN ${JOB_NOTIFICATION_CHANNEL}`);
      const notificationPromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for job notification.')),
          5000,
        );
        listener.on('notification', (notification) => {
          if (notification.channel !== JOB_NOTIFICATION_CHANNEL || !notification.payload) {
            return;
          }

          clearTimeout(timeout);
          resolve(notification.payload);
        });
      });

      const owner = await createUserContext();
      const job = await createRunningJob(owner);
      await JobService.updateProgress(job.id, 70, 'payload-privacy');
      const payload = await notificationPromise;

      expect(JSON.parse(payload)).toEqual({
        jobId: job.id,
        event: 'progress',
      });
      expect(payload).not.toContain('workspaceId');
      expect(payload).not.toContain('payload');
      expect(payload).not.toContain('result');
      expect(payload).not.toContain('sanitizedError');
      expect(payload).not.toContain('queueMessageId');
    } finally {
      await listener.end();
    }
  });
});
