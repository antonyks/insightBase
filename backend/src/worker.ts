import dotenv from 'dotenv';
dotenv.config();

import { PgBoss } from 'pg-boss';
import { ENV } from './config/env';
import { connectDatabase, prisma } from './config/database';
import { logger } from './config/logger';
import { JobService, PgBossJobQueueTransport } from './modules/job';

let boss: PgBoss | undefined;
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  logger.info({ signal }, 'Worker shutdown requested.');

  try {
    await boss?.stop({
      graceful: true,
      close: true,
      timeout: ENV.WORKER_SHUTDOWN_GRACE_MS,
    });
    await prisma.$disconnect();
    logger.info({ signal }, 'Worker stopped cleanly.');
    process.exit(0);
  } catch (error: unknown) {
    logger.error({ signal, err: error }, 'Worker shutdown failed.');
    process.exit(1);
  }
}

async function startWorker() {
  try {
    await connectDatabase();

    boss = new PgBoss({
      connectionString: ENV.DATABASE_URL,
      schema: ENV.PGBOSS_SCHEMA,
      migrate: true,
      createSchema: true,
      supervise: true,
      schedule: false,
    });

    boss.on('error', (error) => {
      logger.error({ err: error }, 'pg-boss emitted an error.');
    });

    boss.on('warning', (warning) => {
      logger.warn({ warning }, 'pg-boss emitted a warning.');
    });

    await boss.start();
    const jobQueueReconciliation =
      await JobService.reconcileQueuedJobsWithoutQueueMessage(
        new PgBossJobQueueTransport(boss),
      );

    logger.info(
      {
        workerConcurrency: ENV.WORKER_CONCURRENCY,
        piscinaThreadCount: ENV.PISCINA_THREAD_COUNT,
        workerShutdownGraceMs: ENV.WORKER_SHUTDOWN_GRACE_MS,
        workerJobHeartbeatIntervalMs: ENV.WORKER_JOB_HEARTBEAT_INTERVAL_MS,
        pgBossSchema: ENV.PGBOSS_SCHEMA,
        jobQueueReconciliation,
      },
      'Worker started with job lifecycle execution infrastructure and no registered business handlers.',
    );
  } catch (error: unknown) {
    logger.error(
      { err: error, pgBossSchema: ENV.PGBOSS_SCHEMA },
      'Worker failed to start.',
    );
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void startWorker();
