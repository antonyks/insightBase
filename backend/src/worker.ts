import dotenv from 'dotenv';
dotenv.config();

import { PgBoss } from 'pg-boss';
import { ENV } from './config/env';
import { connectDatabase, prisma } from './config/database';
import { logger } from './config/logger';
import {
  JobService,
  PgBossJobQueueTransport,
  createJobWorkerHandler,
  ensurePgBossQueue,
} from './modules/job';
import {
  createValidationJobHandler,
  createWorkerCpuTaskPool,
  VALIDATION_JOB_QUEUE,
  WorkerCpuTaskPool,
} from './modules/worker';
import {
  createProviderHealthSamplingJobHandler,
  PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
  ProviderHealthSamplingScheduler,
  startProviderHealthSamplingScheduler,
} from './modules/worker/providerHealthSamplingJob';

let boss: PgBoss | undefined;
let cpuTaskPool: WorkerCpuTaskPool | undefined;
let providerHealthSamplingScheduler: ProviderHealthSamplingScheduler | undefined;
let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  logger.info({ signal }, 'Worker shutdown requested.');

  let shutdownError: unknown;

  providerHealthSamplingScheduler?.stop();
  providerHealthSamplingScheduler = undefined;

  try {
    await boss?.stop({
      graceful: true,
      close: true,
      timeout: ENV.WORKER_SHUTDOWN_GRACE_MS,
    });
  } catch (error: unknown) {
    shutdownError = error;
  }

  try {
    await closeCpuTaskPool();
  } catch (error: unknown) {
    shutdownError ??= error;
  }

  try {
    await prisma.$disconnect();
  } catch (error: unknown) {
    shutdownError ??= error;
  }

  if (shutdownError) {
    logger.error({ signal, err: shutdownError }, 'Worker shutdown failed.');
    process.exit(1);
  }

  logger.info({ signal }, 'Worker stopped cleanly.');
  process.exit(0);
}

async function startWorker() {
  try {
    await connectDatabase();
    cpuTaskPool = createWorkerCpuTaskPool({
      threadCount: ENV.PISCINA_THREAD_COUNT,
    });

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
    await ensurePgBossQueue(boss, VALIDATION_JOB_QUEUE);
    await ensurePgBossQueue(boss, PROVIDER_HEALTH_SAMPLING_JOB_QUEUE);
    await boss.work(
      VALIDATION_JOB_QUEUE,
      {
        includeMetadata: true,
        localConcurrency: ENV.WORKER_CONCURRENCY,
      },
      createJobWorkerHandler(
        createValidationJobHandler(cpuTaskPool),
        {
          boss,
          heartbeatIntervalMs: ENV.WORKER_JOB_HEARTBEAT_INTERVAL_MS,
        },
      ),
    );
    await boss.work(
      PROVIDER_HEALTH_SAMPLING_JOB_QUEUE,
      {
        includeMetadata: true,
        localConcurrency: ENV.WORKER_CONCURRENCY,
      },
      createJobWorkerHandler(
        createProviderHealthSamplingJobHandler(),
        {
          boss,
          heartbeatIntervalMs: ENV.WORKER_JOB_HEARTBEAT_INTERVAL_MS,
        },
      ),
    );
    const workerQueueTransport = new PgBossJobQueueTransport(boss);
    providerHealthSamplingScheduler = startProviderHealthSamplingScheduler({
      intervalMs: ENV.PROVIDER_HEALTH_SAMPLE_INTERVAL_MS,
      queueTransport: workerQueueTransport,
    });
    const jobQueueReconciliation =
      await JobService.reconcileQueuedJobsWithoutQueueMessage(
        workerQueueTransport,
      );
    const staleRunningJobRecovery =
      await JobService.recoverStaleRunningJobs(
        workerQueueTransport,
        { staleJobMs: ENV.WORKER_STALE_JOB_MS },
      );

    logger.info(
      {
        workerConcurrency: ENV.WORKER_CONCURRENCY,
        piscinaThreadCount: ENV.PISCINA_THREAD_COUNT,
        workerShutdownGraceMs: ENV.WORKER_SHUTDOWN_GRACE_MS,
        workerJobHeartbeatIntervalMs: ENV.WORKER_JOB_HEARTBEAT_INTERVAL_MS,
        workerStaleJobMs: ENV.WORKER_STALE_JOB_MS,
        providerHealthSampleIntervalMs: ENV.PROVIDER_HEALTH_SAMPLE_INTERVAL_MS,
        pgBossSchema: ENV.PGBOSS_SCHEMA,
        jobQueueReconciliation,
        staleRunningJobRecovery,
      },
      'Worker started with job lifecycle execution infrastructure, validation job handler and provider health sampling handler.',
    );
  } catch (error: unknown) {
    logger.error(
      { err: error, pgBossSchema: ENV.PGBOSS_SCHEMA },
      'Worker failed to start.',
    );
    providerHealthSamplingScheduler?.stop();
    providerHealthSamplingScheduler = undefined;
    await closeCpuTaskPool().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
}

async function closeCpuTaskPool(): Promise<void> {
  const pool = cpuTaskPool;
  cpuTaskPool = undefined;
  if (!pool) return;

  try {
    await pool.close();
  } catch (error: unknown) {
    await pool.destroy().catch(() => undefined);
    throw error;
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void startWorker();
