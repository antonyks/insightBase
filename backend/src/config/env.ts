import dotenv from 'dotenv';
dotenv.config();

function ensureEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function positiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) return defaultValue;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}

function positiveIntegerMsEnv(name: string, defaultValue: number): number {
  return positiveIntegerEnv(name, defaultValue);
}

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 5000,
  DATABASE_URL: ensureEnvVar('DATABASE_URL'),
  JWT_SECRET: ensureEnvVar('JWT_SECRET'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://host.docker.internal:11434',
  OLLAMA_MODEL: ensureEnvVar('OLLAMA_MODEL'),
  WORKER_CONCURRENCY: positiveIntegerEnv('WORKER_CONCURRENCY', 1),
  PISCINA_THREAD_COUNT: positiveIntegerEnv('PISCINA_THREAD_COUNT', 1),
  WORKER_SHUTDOWN_GRACE_MS: positiveIntegerMsEnv('WORKER_SHUTDOWN_GRACE_MS', 30_000),
  WORKER_JOB_HEARTBEAT_INTERVAL_MS: positiveIntegerMsEnv('WORKER_JOB_HEARTBEAT_INTERVAL_MS', 10_000),
  WORKER_STALE_JOB_MS: positiveIntegerMsEnv('WORKER_STALE_JOB_MS', 300_000),
  PGBOSS_SCHEMA: process.env.PGBOSS_SCHEMA || 'pgboss',
};
