import dotenv from 'dotenv';
dotenv.config();

function ensureEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 5000,
  DATABASE_URL: ensureEnvVar('DATABASE_URL'),
  JWT_SECRET: ensureEnvVar('JWT_SECRET'),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  OLLAMA_HOST: process.env.OLLAMA_HOST || 'http://host.docker.internal:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama2'
};
