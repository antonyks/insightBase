import { Prisma } from '@prisma/client';
import { JobMetricModel, JobMetricSelectFields, SelectedJobMetric } from './jobMetric.model';

type JobMetricRepositoryClient = Pick<Prisma.TransactionClient, 'jobMetric'>;

export const JobMetricRepository = {
  async create(
    data: Prisma.JobMetricUncheckedCreateInput,
    db: JobMetricRepositoryClient = { jobMetric: JobMetricModel },
  ): Promise<SelectedJobMetric> {
    return db.jobMetric.create({
      data,
      select: JobMetricSelectFields,
    });
  },
};
