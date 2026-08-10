import type { PgBoss, SendOptions } from 'pg-boss';
import { JobQueuePayload, JobQueueSendOptions, JobQueueTransport } from './job.types';

export class PgBossJobQueueTransport implements JobQueueTransport {
  constructor(private readonly boss: PgBoss) {}

  async send(
    queueName: string,
    data: JobQueuePayload,
    options?: JobQueueSendOptions,
  ): Promise<string | null> {
    await ensurePgBossQueue(this.boss, queueName);

    return this.boss.send(queueName, data, options as SendOptions | undefined);
  }
}

export async function ensurePgBossQueue(
  boss: Pick<PgBoss, 'createQueue'>,
  queueName: string,
): Promise<void> {
  await boss.createQueue(queueName).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('already exists')) {
      return;
    }

    throw error;
  });
}
