import { Prisma } from '@prisma/client';
import { JobMetricRepository } from './jobMetric.repository';
import { SelectedJobMetric } from './jobMetric.model';
import { JobMetricCreateInput } from './jobMetric.types';

type JobMetricServiceClient = Pick<Prisma.TransactionClient, 'jobMetric'>;

function normalizeDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value));
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export const JobMetricService = {
  async recordFinalizedJob(
    input: JobMetricCreateInput,
    db?: JobMetricServiceClient,
  ): Promise<SelectedJobMetric | null> {
    try {
      return await JobMetricRepository.create({
        jobId: input.jobId,
        workspaceId: input.workspaceId,
        jobType: input.jobType,
        outcome: input.outcome,
        attempts: input.attempts,
        queueWaitMs: normalizeDuration(input.queueWaitMs),
        executionDurationMs: normalizeDuration(input.executionDurationMs),
        errorCode: input.errorCode,
      }, db);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return null;
      }

      throw error;
    }
  },
};
