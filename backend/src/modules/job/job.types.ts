import type { Prisma } from '@prisma/client';
import { JobStatus } from './job.model';

export type JobQueuePayload = {
  jobId: number;
};

export type JobQueueSendOptions = Record<string, unknown>;

export interface JobQueueTransport {
  send(
    queueName: string,
    data: JobQueuePayload,
    options?: JobQueueSendOptions,
  ): Promise<string | null>;
}

export interface EnqueueJobInput {
  workspaceId: number;
  createdByUserId: number;
  type: string;
  payload?: Prisma.InputJsonValue;
  maxAttempts?: number;
  stage?: string;
  queueName?: string;
}

export interface JobReconciliationResult {
  skipped: boolean;
  scanned: number;
  reenqueued: number;
  failed: number;
}

export interface PublicJob {
  id: number;
  workspaceId: number;
  type: string;
  status: JobStatus;
  progress: number;
  stage: string;
  result: Prisma.JsonValue | null;
  errorCode: string | null;
  sanitizedError: string | null;
  attempts: number;
  maxAttempts: number;
  createdByUserId: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  heartbeatAt: Date | null;
  cancelRequestedAt: Date | null;
}

export type JobSseEventType =
  | 'snapshot'
  | 'progress'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'heartbeat';
