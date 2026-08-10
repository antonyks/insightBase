import path from 'node:path';
import { Prisma } from '@prisma/client';
import { InvalidInputError } from '../../errors';
import { JobService, PublicJob, JobQueueTransport } from '../job';
import { JobWorkerHandler } from '../job/job.worker';
import { WorkerCpuTaskPool } from './workerTaskPool';

export const VALIDATION_JOB_TYPE = 'internal.validation';
export const VALIDATION_JOB_QUEUE = VALIDATION_JOB_TYPE;
export const VALIDATION_JOB_SUCCESS_MAX_ATTEMPTS = 1;
export const VALIDATION_JOB_FAILURE_MAX_ATTEMPTS = 2;
export const VALIDATION_JOB_CHECKSUM_SEED = 'silocore-validation-v1';
export const VALIDATION_JOB_CHECKSUM_ITERATIONS = 25_000;

export type ValidationJobMode = 'success' | 'fail';

export interface EnqueueValidationJobInput {
  workspaceId: number;
  createdByUserId: number;
  mode?: unknown;
}

export interface ValidationChecksumInput {
  seed: string;
  iterations: number;
}

export interface ValidationChecksumResult extends Prisma.JsonObject {
  checksum: string;
  iterations: number;
  seedLength: number;
}

export function parseValidationJobMode(mode: unknown): ValidationJobMode {
  if (mode === undefined || mode === null) return 'success';
  if (mode === 'success' || mode === 'fail') return mode;

  throw new InvalidInputError(
    'Validation job mode must be success or fail.',
    'VALIDATION_JOB_MODE_INVALID',
  );
}

export async function enqueueValidationJob(
  input: EnqueueValidationJobInput,
  queueTransport: JobQueueTransport,
): Promise<PublicJob> {
  const mode = parseValidationJobMode(input.mode);
  const job = await JobService.enqueueJob({
    workspaceId: input.workspaceId,
    createdByUserId: input.createdByUserId,
    type: VALIDATION_JOB_TYPE,
    queueName: VALIDATION_JOB_QUEUE,
    payload: { mode },
    maxAttempts: mode === 'fail'
      ? VALIDATION_JOB_FAILURE_MAX_ATTEMPTS
      : VALIDATION_JOB_SUCCESS_MAX_ATTEMPTS,
    stage: 'validation_queued',
  }, queueTransport);

  return JobService.getJobInWorkspace(job.id, input.workspaceId);
}

export function createValidationJobHandler(
  cpuTaskPool: WorkerCpuTaskPool,
): JobWorkerHandler {
  return async ({ job, payload, signal, heartbeat, checkpointCancellation }) => {
    const mode = parsePayloadMode(payload);

    await checkpointCancellation();
    await JobService.updateProgress(job.id, 25, 'validation_preparing');
    await heartbeat();

    const checksum = await cpuTaskPool.run<ValidationChecksumInput, ValidationChecksumResult>({
      filename: getValidationChecksumWorkerFilename(),
      name: 'runValidationChecksum',
      input: {
        seed: VALIDATION_JOB_CHECKSUM_SEED,
        iterations: VALIDATION_JOB_CHECKSUM_ITERATIONS,
      },
      signal,
    });

    await checkpointCancellation();
    await JobService.updateProgress(job.id, 75, 'validation_checksum_complete');
    await heartbeat();

    if (mode === 'fail') {
      throw new Error('Deterministic validation job forced failure.');
    }

    return {
      mode,
      checksum: checksum.checksum,
      iterations: checksum.iterations,
      seedLength: checksum.seedLength,
    };
  };
}

export function getValidationChecksumWorkerFilename(): string {
  return path.resolve(process.cwd(), 'worker-tasks/validationChecksum.worker.js');
}

function parsePayloadMode(payload: Prisma.JsonValue | null): ValidationJobMode {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'success';
  }

  return parseValidationJobMode(payload.mode);
}
