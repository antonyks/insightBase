import { prisma } from '../../config/database';
import { JobMetric, JobMetricOutcome, Prisma } from '@prisma/client';

export { JobMetric, JobMetricOutcome };

export const JobMetricSelectFields = {
  id: true,
  jobId: true,
  workspaceId: true,
  jobType: true,
  outcome: true,
  attempts: true,
  queueWaitMs: true,
  executionDurationMs: true,
  errorCode: true,
  createdAt: true,
} as const;

export type SelectedJobMetric = Prisma.JobMetricGetPayload<{
  select: typeof JobMetricSelectFields;
}>;

export const JobMetricModel = prisma.jobMetric;
