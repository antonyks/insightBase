import path from 'node:path';
import Piscina from 'piscina';
import type { TransferList } from 'piscina/dist/task_queue';

export const WORKER_CPU_TASK_FAILED_CODE = 'WORKER_CPU_TASK_FAILED';
export const WORKER_CPU_TASK_FAILED_MESSAGE = 'Worker CPU task failed.';
export const WORKER_CPU_TASK_CANCELLED_CODE = 'WORKER_CPU_TASK_CANCELLED';
export const WORKER_CPU_TASK_CANCELLED_MESSAGE = 'Worker CPU task cancelled.';

export interface WorkerCpuTaskRunInput<TInput> {
  filename: string;
  name?: string;
  input: TInput;
  signal?: AbortSignal;
  transferList?: TransferList;
}

export interface WorkerCpuTaskPool {
  run<TInput, TOutput>(task: WorkerCpuTaskRunInput<TInput>): Promise<TOutput>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export interface WorkerCpuTaskPoolConfig {
  threadCount: number;
}

interface PiscinaPoolAdapter {
  run(task: unknown, options?: {
    filename?: string | null;
    name?: string | null;
    signal?: AbortSignal | null;
    transferList?: TransferList;
  }): Promise<unknown>;
  close(options?: { force?: boolean }): Promise<void>;
  destroy(): Promise<void>;
}

export class WorkerTaskError extends Error {
  readonly code = WORKER_CPU_TASK_FAILED_CODE;
  readonly sanitizedError = WORKER_CPU_TASK_FAILED_MESSAGE;

  constructor() {
    super(WORKER_CPU_TASK_FAILED_MESSAGE);
    this.name = 'WorkerTaskError';
  }
}

export class WorkerTaskCancelledError extends Error {
  readonly code = WORKER_CPU_TASK_CANCELLED_CODE;
  readonly sanitizedError = WORKER_CPU_TASK_CANCELLED_MESSAGE;

  constructor() {
    super(WORKER_CPU_TASK_CANCELLED_MESSAGE);
    this.name = 'WorkerTaskCancelledError';
  }
}

export class PiscinaWorkerCpuTaskPool implements WorkerCpuTaskPool {
  constructor(private readonly pool: PiscinaPoolAdapter) {}

  async run<TInput, TOutput>(task: WorkerCpuTaskRunInput<TInput>): Promise<TOutput> {
    assertAbsoluteTaskFilename(task.filename);

    try {
      return await this.pool.run(task.input, {
        filename: task.filename,
        ...(task.name ? { name: task.name } : {}),
        ...(task.signal ? { signal: task.signal } : {}),
        ...(task.transferList ? { transferList: task.transferList } : {}),
      }) as TOutput;
    } catch (error: unknown) {
      if (task.signal?.aborted || isAbortLikeError(error)) {
        throw new WorkerTaskCancelledError();
      }

      throw new WorkerTaskError();
    }
  }

  close(): Promise<void> {
    return this.pool.close();
  }

  destroy(): Promise<void> {
    return this.pool.destroy();
  }
}

export function createWorkerCpuTaskPool(config: WorkerCpuTaskPoolConfig): WorkerCpuTaskPool {
  assertValidThreadCount(config.threadCount);

  return new PiscinaWorkerCpuTaskPool(new Piscina({
    minThreads: config.threadCount,
    maxThreads: config.threadCount,
  }));
}

function assertAbsoluteTaskFilename(filename: string): void {
  if (!path.isAbsolute(filename)) {
    throw new WorkerTaskError();
  }
}

function assertValidThreadCount(threadCount: number): void {
  if (!Number.isInteger(threadCount) || threadCount < 1) {
    throw new Error('Worker CPU task pool threadCount must be a positive integer.');
  }
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return error.name === 'AbortError';
}
