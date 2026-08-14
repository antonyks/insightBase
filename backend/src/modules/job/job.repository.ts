import { Prisma, JobStatus } from '@prisma/client';
import { prisma } from '../../config/database';
import { JobSelectFields, SelectedJob } from './job.model';

type JobRepositoryClient = Pick<Prisma.TransactionClient, 'job' | 'jobMetric' | '$queryRaw'>;

export interface CreateQueuedJobData {
  workspaceId: number;
  createdByUserId: number;
  type: string;
  payload: Prisma.InputJsonValue;
  maxAttempts: number;
  stage: string;
}

export const JobRepository = {
  createQueuedJob(data: CreateQueuedJobData): Promise<SelectedJob> {
    return prisma.job.create({
      data: {
        workspaceId: data.workspaceId,
        createdByUserId: data.createdByUserId,
        type: data.type,
        status: JobStatus.QUEUED,
        payload: data.payload,
        maxAttempts: data.maxAttempts,
        stage: data.stage,
      },
      select: JobSelectFields,
    });
  },

  findById(id: number): Promise<SelectedJob | null> {
    return prisma.job.findUnique({
      where: { id },
      select: JobSelectFields,
    });
  },

  findByIdInWorkspace(id: number, workspaceId: number): Promise<SelectedJob | null> {
    return prisma.job.findFirst({
      where: {
        id,
        workspaceId,
      },
      select: JobSelectFields,
    });
  },

  findQueuedJobsWithoutQueueMessage(
    limit: number,
    db: JobRepositoryClient = prisma,
  ): Promise<SelectedJob[]> {
    return db.job.findMany({
      where: {
        status: JobStatus.QUEUED,
        queueMessageId: null,
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: JobSelectFields,
    });
  },

  findStaleRunningJobs(
    staleBefore: Date,
    limit: number,
    db: JobRepositoryClient = prisma,
  ): Promise<SelectedJob[]> {
    return db.job.findMany({
      where: {
        status: JobStatus.RUNNING,
        OR: [
          {
            heartbeatAt: {
              lt: staleBefore,
            },
          },
          {
            heartbeatAt: null,
            startedAt: {
              lt: staleBefore,
            },
          },
        ],
      },
      orderBy: { startedAt: 'asc' },
      take: limit,
      select: JobSelectFields,
    });
  },

  updateJob(
    id: number,
    data: Prisma.JobUpdateInput,
    db: JobRepositoryClient = prisma,
  ): Promise<SelectedJob> {
    return db.job.update({
      where: { id },
      data,
      select: JobSelectFields,
    });
  },

  runWithJobQueueReconciliationLock<T>(
    callback: (lockAcquired: boolean, db: JobRepositoryClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('silocore.job_queue_reconciliation', 0)) AS acquired
      `;

      return callback(result[0]?.acquired === true, tx);
    });
  },

  runWithStaleRunningJobRecoveryLock<T>(
    callback: (lockAcquired: boolean, db: JobRepositoryClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('silocore.stale_running_job_recovery', 0)) AS acquired
      `;

      return callback(result[0]?.acquired === true, tx);
    });
  },
};
