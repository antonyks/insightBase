import type { PgBoss as PgBossType } from 'pg-boss';
import { ENV } from '../../config/env';
import { PgBossJobQueueTransport } from './jobQueue.transport';
import { JobQueueTransport } from './job.types';

let boss: PgBossType | undefined;
let transport: JobQueueTransport | undefined;
let startPromise: Promise<JobQueueTransport> | undefined;

export async function startJobQueueClient(): Promise<JobQueueTransport> {
  if (transport) return transport;
  if (startPromise) return startPromise;

  startPromise = startClient();

  try {
    return await startPromise;
  } finally {
    startPromise = undefined;
  }
}

export function getJobQueueTransport(): JobQueueTransport {
  if (!transport) {
    throw new Error('Job queue client has not been started.');
  }

  return transport;
}

export async function stopJobQueueClient(): Promise<void> {
  const client = boss;
  boss = undefined;
  transport = undefined;
  startPromise = undefined;

  if (!client) return;

  await client.stop({ graceful: true, close: true });
}

async function startClient(): Promise<JobQueueTransport> {
  const { PgBoss } = await importPgBoss();
  const client = new PgBoss({
    connectionString: ENV.DATABASE_URL,
    schema: ENV.PGBOSS_SCHEMA,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });

  await client.start();
  boss = client;
  transport = new PgBossJobQueueTransport(client);

  return transport;
}

async function importPgBoss(): Promise<typeof import('pg-boss')> {
  const dynamicImport = new Function('moduleName', 'return import(moduleName)') as
    (moduleName: string) => Promise<typeof import('pg-boss')>;

  return dynamicImport('pg-boss');
}
