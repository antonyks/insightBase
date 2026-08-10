const mockPiscinaInstances: MockPiscinaPool[] = [];

class MockPiscinaPool {
  public run = jest.fn<Promise<unknown>, [unknown, unknown?]>();
  public close = jest.fn<Promise<void>, [unknown?]>();
  public destroy = jest.fn<Promise<void>, []>();

  constructor(public readonly options: unknown) {
    this.run.mockResolvedValue(undefined);
    this.close.mockResolvedValue(undefined);
    this.destroy.mockResolvedValue(undefined);
    mockPiscinaInstances.push(this);
  }
}

jest.mock('piscina', () => jest.fn().mockImplementation((options) => new MockPiscinaPool(options)));

import path from 'node:path';
import {
  createWorkerCpuTaskPool,
  PiscinaWorkerCpuTaskPool,
  WorkerTaskCancelledError,
  WorkerTaskError,
} from '../../modules/worker';

class FakePiscinaPool {
  public run = jest.fn<Promise<unknown>, [unknown, unknown?]>();
  public close = jest.fn<Promise<void>, [unknown?]>();
  public destroy = jest.fn<Promise<void>, []>();

  constructor() {
    this.run.mockResolvedValue(undefined);
    this.close.mockResolvedValue(undefined);
    this.destroy.mockResolvedValue(undefined);
  }
}

describe('Worker CPU task pool', () => {
  beforeEach(() => {
    mockPiscinaInstances.length = 0;
  });

  it('creates a Piscina pool with the effective thread count as min and max threads', () => {
    createWorkerCpuTaskPool({ threadCount: 3 });

    expect(mockPiscinaInstances).toHaveLength(1);
    expect(mockPiscinaInstances[0].options).toEqual({
      minThreads: 3,
      maxThreads: 3,
    });
  });

  it('returns successful task results and forwards run options', async () => {
    const fakePool = new FakePiscinaPool();
    fakePool.run.mockResolvedValue({ total: 42 });
    const taskPool = new PiscinaWorkerCpuTaskPool(fakePool);
    const signal = new AbortController().signal;
    const filename = path.resolve(__dirname, 'fixture-worker.js');

    await expect(taskPool.run<{ value: number }, { total: number }>({
      filename,
      name: 'calculate',
      input: { value: 21 },
      signal,
    })).resolves.toEqual({ total: 42 });

    expect(fakePool.run).toHaveBeenCalledWith(
      { value: 21 },
      {
        filename,
        name: 'calculate',
        signal,
      },
    );
  });

  it('normalizes raw worker errors before they reach job state', async () => {
    const fakePool = new FakePiscinaPool();
    fakePool.run.mockRejectedValue(new Error('password=secret failed'));
    const taskPool = new PiscinaWorkerCpuTaskPool(fakePool);

    await expect(taskPool.run({
      filename: path.resolve(__dirname, 'fixture-worker.js'),
      input: { value: 1 },
    })).rejects.toMatchObject({
      name: 'WorkerTaskError',
      code: 'WORKER_CPU_TASK_FAILED',
      sanitizedError: 'Worker CPU task failed.',
    });
    await expect(taskPool.run({
      filename: path.resolve(__dirname, 'fixture-worker.js'),
      input: { value: 1 },
    })).rejects.not.toThrow('secret');
  });

  it('normalizes aborted task errors as cancellation', async () => {
    const fakePool = new FakePiscinaPool();
    fakePool.run.mockRejectedValue(new Error('raw abort details'));
    const taskPool = new PiscinaWorkerCpuTaskPool(fakePool);
    const abortController = new AbortController();
    abortController.abort();

    await expect(taskPool.run({
      filename: path.resolve(__dirname, 'fixture-worker.js'),
      input: { value: 1 },
      signal: abortController.signal,
    })).rejects.toBeInstanceOf(WorkerTaskCancelledError);
  });

  it('rejects non-absolute task filenames with a sanitized task error', async () => {
    const taskPool = new PiscinaWorkerCpuTaskPool(new FakePiscinaPool());

    await expect(taskPool.run({
      filename: 'relative-worker.js',
      input: {},
    })).rejects.toBeInstanceOf(WorkerTaskError);
  });

  it('delegates close and destroy to the underlying pool', async () => {
    const fakePool = new FakePiscinaPool();
    const taskPool = new PiscinaWorkerCpuTaskPool(fakePool);

    await taskPool.close();
    await taskPool.destroy();

    expect(fakePool.close).toHaveBeenCalledTimes(1);
    expect(fakePool.destroy).toHaveBeenCalledTimes(1);
  });
});
