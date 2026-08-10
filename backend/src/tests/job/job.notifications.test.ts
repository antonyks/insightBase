import {
  bestEffortNotifyJobChanged,
  JobNotificationListener,
  JOB_NOTIFICATION_CHANNEL,
  notifyJobChanged,
  parseJobNotificationPayload,
} from '../../modules/job/job.notifications';
import { logger } from '../../config/logger';
import { mockPrisma } from '../setup';

type Listener = (...args: never[]) => void;

class FakePgClient {
  public readonly listeners = new Map<string, Listener[]>();
  public readonly queries: string[] = [];
  public connect = jest.fn(async () => undefined);
  public end = jest.fn(async () => undefined);

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  async query(sql: string): Promise<void> {
    this.queries.push(sql);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value as never);
    }
  }
}

describe('job notifications', () => {
  it('parses valid notification payloads and rejects malformed or unsafe payloads', () => {
    expect(parseJobNotificationPayload('{"jobId":1,"event":"progress"}')).toEqual({
      jobId: 1,
      event: 'progress',
    });

    expect(parseJobNotificationPayload(undefined)).toBeNull();
    expect(parseJobNotificationPayload('not-json')).toBeNull();
    expect(parseJobNotificationPayload('{"jobId":"1","event":"progress"}')).toBeNull();
    expect(parseJobNotificationPayload('{"jobId":1,"event":"unknown"}')).toBeNull();
    expect(parseJobNotificationPayload('{"jobId":0,"event":"progress"}')).toBeNull();
    expect(parseJobNotificationPayload('{"jobId":1}')).toBeNull();
  });

  it('publishes only job id and event hint in pg_notify payloads', async () => {
    mockPrisma.$executeRaw.mockResolvedValue(undefined);

    await notifyJobChanged(42, 'succeeded');

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const call = mockPrisma.$executeRaw.mock.calls[0] as unknown[];
    expect(call).toContain(JOB_NOTIFICATION_CHANNEL);
    expect(JSON.parse(call[2] as string)).toEqual({
      jobId: 42,
      event: 'succeeded',
    });
    const serializedCall = JSON.stringify(call);
    expect(serializedCall).not.toContain('workspaceId');
    expect(serializedCall).not.toContain('payload');
    expect(serializedCall).not.toContain('queueMessageId');
    expect(serializedCall).not.toContain('sanitizedError');
  });

  it('treats publish failures as best-effort', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('database offline'));

    await expect(bestEffortNotifyJobChanged(42, 'failed')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 42,
        event: 'failed',
        operation: 'job.notify',
      }),
      'Job notification failed.',
    );
    warnSpy.mockRestore();
  });

  it('routes notifications only to subscribers of the matching job id', async () => {
    const fakeClient = new FakePgClient();
    const listener = new JobNotificationListener(() => fakeClient as never);
    const jobOneSubscriber = jest.fn();
    const jobTwoSubscriber = jest.fn();

    const unsubscribeOne = listener.subscribe(1, jobOneSubscriber);
    listener.subscribe(2, jobTwoSubscriber);
    await Promise.resolve();
    await Promise.resolve();

    fakeClient.emit('notification', {
      channel: JOB_NOTIFICATION_CHANNEL,
      payload: '{"jobId":1,"event":"progress"}',
    });
    fakeClient.emit('notification', {
      channel: JOB_NOTIFICATION_CHANNEL,
      payload: '{"jobId":2,"event":"failed"}',
    });
    fakeClient.emit('notification', {
      channel: 'other_channel',
      payload: '{"jobId":1,"event":"progress"}',
    });
    fakeClient.emit('notification', {
      channel: JOB_NOTIFICATION_CHANNEL,
      payload: 'not-json',
    });

    expect(fakeClient.connect).toHaveBeenCalledTimes(1);
    expect(fakeClient.queries).toEqual([`LISTEN ${JOB_NOTIFICATION_CHANNEL}`]);
    expect(jobOneSubscriber).toHaveBeenCalledWith({ jobId: 1, event: 'progress' });
    expect(jobTwoSubscriber).toHaveBeenCalledWith({ jobId: 2, event: 'failed' });

    unsubscribeOne();
    fakeClient.emit('notification', {
      channel: JOB_NOTIFICATION_CHANNEL,
      payload: '{"jobId":1,"event":"succeeded"}',
    });
    expect(jobOneSubscriber).toHaveBeenCalledTimes(1);

    await listener.close();
    expect(fakeClient.end).toHaveBeenCalledTimes(1);
  });
});
