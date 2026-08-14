import {
  GenerationUsageOutcome,
  JobMetricOutcome,
  JobStatus,
  Prisma,
  ProviderHealthSampleStatus,
} from '@prisma/client';
import { logger } from '../../../config/logger';
import { prisma } from '../../../config/database';
import { ENV } from '../../../config/env';
import { LlmRuntimeService } from '../../llm/llmRuntime.service';
import { UserRole, UserStatus } from '../../user/user.model';
import { JobQueueTransport } from '../../job';
import { getJobQueueTransport } from '../../job/jobQueue.client';
import { enqueueValidationJob } from '../../worker/validationJob';
import {
  AdminAnalyticsSummary,
  AdminAnalyticsSummaryInput,
  AdminSystemStatus,
} from './adminSystem.types';
import { InvalidInputError } from '../../../errors';

const OFFLINE_INFERENCE_STATUS: AdminSystemStatus['inference'] = {
  status: 'offline',
  providers: 0,
  errors: 0,
  skipped: 0,
};

export const AdminSystemService = {
  async getAnalyticsSummary(input: AdminAnalyticsSummaryInput = {}): Promise<AdminAnalyticsSummary> {
    const period = parseAnalyticsPeriod(input);
    const generationWhere = toGenerationUsageWhere(period);
    const jobMetricWhere = toJobMetricWhere(period);
    const providerHealthWhere = toProviderHealthSampleWhere(period);
    const [
      totalProviders,
      activeProviders,
      disabledProviders,
      totalUsers,
      activeUsers,
      bannedUsers,
      deletedUsers,
      generationTotal,
      generationOutcomes,
      generationAggregates,
      jobTotal,
      jobStatuses,
      jobMetricTotal,
      jobMetricOutcomes,
      jobMetricAggregates,
      providerHealthTotal,
      providerHealthStatuses,
      providerHealthAggregates,
      latestProviderHealthSample,
    ] = await Promise.all([
      prisma.llmProviderConfig.count({ where: { deletedAt: null } }),
      prisma.llmProviderConfig.count({ where: { deletedAt: null, enabled: true } }),
      prisma.llmProviderConfig.count({ where: { deletedAt: null, enabled: false } }),
      prisma.user.count({ where: { role: UserRole.USER } }),
      prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.ACTIVE } }),
      prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.BANNED } }),
      prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.DELETED } }),
      prisma.generationUsage.count({ where: generationWhere }),
      prisma.generationUsage.groupBy({
        by: ['outcome'],
        where: generationWhere,
        _count: { _all: true },
      }),
      prisma.generationUsage.aggregate({
        where: generationWhere,
        _avg: { latencyMs: true },
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
      }),
      prisma.job.count(),
      prisma.job.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      prisma.jobMetric.count({ where: jobMetricWhere }),
      prisma.jobMetric.groupBy({
        by: ['outcome'],
        where: jobMetricWhere,
        _count: { _all: true },
      }),
      prisma.jobMetric.aggregate({
        where: jobMetricWhere,
        _avg: { queueWaitMs: true, executionDurationMs: true, attempts: true },
      }),
      prisma.providerHealthSample.count({ where: providerHealthWhere }),
      prisma.providerHealthSample.groupBy({
        by: ['status'],
        where: providerHealthWhere,
        _count: { _all: true },
      }),
      prisma.providerHealthSample.aggregate({
        where: providerHealthWhere,
        _avg: { latencyMs: true },
      }),
      prisma.providerHealthSample.findFirst({
        where: providerHealthWhere,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const generationSucceeded = countGrouped(generationOutcomes, 'outcome', GenerationUsageOutcome.SUCCEEDED);
    const generationFailed = countGrouped(generationOutcomes, 'outcome', GenerationUsageOutcome.FAILED);
    const generationAborted = countGrouped(generationOutcomes, 'outcome', GenerationUsageOutcome.ABORTED);
    const jobMetricSucceeded = countGrouped(jobMetricOutcomes, 'outcome', JobMetricOutcome.SUCCEEDED);
    const jobMetricFailed = countGrouped(jobMetricOutcomes, 'outcome', JobMetricOutcome.FAILED);
    const jobMetricCancelled = countGrouped(jobMetricOutcomes, 'outcome', JobMetricOutcome.CANCELLED);
    const providerHealthSuccess = countGrouped(providerHealthStatuses, 'status', ProviderHealthSampleStatus.SUCCESS);
    const providerHealthError = countGrouped(providerHealthStatuses, 'status', ProviderHealthSampleStatus.ERROR);
    const providerHealthSkipped = countGrouped(providerHealthStatuses, 'status', ProviderHealthSampleStatus.SKIPPED);

    return {
      period: {
        from: period.from?.toISOString() ?? null,
        to: period.to?.toISOString() ?? null,
      },
      providers: {
        total: totalProviders,
        active: activeProviders,
        disabled: disabledProviders,
      },
      users: {
        total: totalUsers,
        active: activeUsers,
        banned: bannedUsers,
        deleted: deletedUsers,
        review: bannedUsers + deletedUsers,
      },
      generation: {
        total: generationTotal,
        succeeded: generationSucceeded,
        failed: generationFailed,
        aborted: generationAborted,
        successRate: rate(generationSucceeded, generationTotal),
        failureRate: rate(generationFailed, generationTotal),
        abortRate: rate(generationAborted, generationTotal),
        averageLatencyMs: nullableRounded(generationAggregates._avg.latencyMs),
        inputTokens: generationAggregates._sum.inputTokens ?? 0,
        outputTokens: generationAggregates._sum.outputTokens ?? 0,
        totalTokens: generationAggregates._sum.totalTokens ?? 0,
      },
      jobs: {
        total: jobTotal,
        current: {
          queued: countGrouped(jobStatuses, 'status', JobStatus.QUEUED),
          running: countGrouped(jobStatuses, 'status', JobStatus.RUNNING),
          cancelRequested: countGrouped(jobStatuses, 'status', JobStatus.CANCEL_REQUESTED),
          cancelled: countGrouped(jobStatuses, 'status', JobStatus.CANCELLED),
          succeeded: countGrouped(jobStatuses, 'status', JobStatus.SUCCEEDED),
          failed: countGrouped(jobStatuses, 'status', JobStatus.FAILED),
        },
        finalized: {
          total: jobMetricTotal,
          succeeded: jobMetricSucceeded,
          failed: jobMetricFailed,
          cancelled: jobMetricCancelled,
        },
        averageQueueWaitMs: nullableRounded(jobMetricAggregates._avg.queueWaitMs),
        averageExecutionDurationMs: nullableRounded(jobMetricAggregates._avg.executionDurationMs),
        averageAttempts: nullableRounded(jobMetricAggregates._avg.attempts),
      },
      providerHealth: {
        total: providerHealthTotal,
        success: providerHealthSuccess,
        error: providerHealthError,
        skipped: providerHealthSkipped,
        errorRate: rate(providerHealthError, providerHealthTotal),
        averageLatencyMs: nullableRounded(providerHealthAggregates._avg.latencyMs),
        latestSampleAt: latestProviderHealthSample?.createdAt.toISOString() ?? null,
      },
    };
  },

  async getSystemStatus(): Promise<AdminSystemStatus> {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      logger.error({ err: error }, 'Admin system database health check failed');

      return {
        backend: {
          status: 'online',
        },
        database: {
          status: 'error',
          errorMessage: 'Database health check failed',
        },
        inference: OFFLINE_INFERENCE_STATUS,
      };
    }

    const recentInference = await getRecentProviderHealthInferenceStatus(ENV.PROVIDER_HEALTH_SAMPLE_RECENT_MS);
    const inference = recentInference ?? await getLiveProviderInferenceStatus();

    return {
      backend: {
        status: 'online',
      },
      database: {
        status: 'online',
      },
      inference: {
        status: inference.status,
        providers: inference.providers,
        errors: inference.errors,
        skipped: inference.skipped,
      },
    };
  },

  async enqueueValidationJob(
    input: { workspaceId: number; createdByUserId: number; mode?: unknown },
    queueTransport: JobQueueTransport = getJobQueueTransport(),
  ) {
    return enqueueValidationJob(input, queueTransport);
  },
};

type AnalyticsPeriod = {
  from: Date | null;
  to: Date | null;
};

type GroupedCount<K extends string, V extends string> = Record<K, V> & {
  _count?: true | {
    _all?: number;
  };
};

function parseAnalyticsPeriod(input: AdminAnalyticsSummaryInput): AnalyticsPeriod {
  const from = parseOptionalDate(input.from, 'from');
  const to = parseOptionalDate(input.to, 'to');

  if (from && to && from.getTime() >= to.getTime()) {
    throw new InvalidInputError('from must be earlier than to.', 'ANALYTICS_PERIOD_INVALID');
  }

  return { from, to };
}

function parseOptionalDate(value: unknown, name: string): Date | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidInputError(`${name} must be an ISO date-time string.`, 'ANALYTICS_PERIOD_INVALID');
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidInputError(`${name} must be an ISO date-time string.`, 'ANALYTICS_PERIOD_INVALID');
  }

  return date;
}

function toGenerationUsageWhere(period: AnalyticsPeriod): Prisma.GenerationUsageWhereInput {
  if (!period.from && !period.to) return {};

  return {
    createdAt: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.to ? { lt: period.to } : {}),
    },
  };
}

function toJobMetricWhere(period: AnalyticsPeriod): Prisma.JobMetricWhereInput {
  if (!period.from && !period.to) return {};

  return {
    createdAt: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.to ? { lt: period.to } : {}),
    },
  };
}

function toProviderHealthSampleWhere(period: AnalyticsPeriod): Prisma.ProviderHealthSampleWhereInput {
  if (!period.from && !period.to) return {};

  return {
    createdAt: {
      ...(period.from ? { gte: period.from } : {}),
      ...(period.to ? { lt: period.to } : {}),
    },
  };
}

function countGrouped<K extends string, V extends string>(
  groups: GroupedCount<K, V>[],
  key: K,
  value: V,
): number {
  const count = groups.find((group) => group[key] === value)?._count;
  return typeof count === 'object' ? count._all ?? 0 : 0;
}

function rate(count: number, total: number): number {
  if (total === 0) return 0;
  return count / total;
}

function nullableRounded(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.round(value);
}

type InferenceStatusSummary = AdminSystemStatus['inference'];

async function getRecentProviderHealthInferenceStatus(
  recentMs: number,
): Promise<InferenceStatusSummary | null> {
  const activeProviders = await prisma.llmProviderConfig.findMany({
    where: {
      enabled: true,
      deletedAt: null,
    },
    select: { id: true },
  });

  if (activeProviders.length === 0) {
    return OFFLINE_INFERENCE_STATUS;
  }

  const activeProviderIds = activeProviders.map((provider) => provider.id);
  const recentSamples = await prisma.providerHealthSample.findMany({
    where: {
      providerId: { in: activeProviderIds },
      createdAt: {
        gte: new Date(Date.now() - recentMs),
      },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      providerId: true,
      status: true,
    },
  });

  const latestSamplesByProvider = new Map<number, ProviderHealthSampleStatus>();
  for (const sample of recentSamples) {
    if (!latestSamplesByProvider.has(sample.providerId)) {
      latestSamplesByProvider.set(sample.providerId, sample.status);
    }
  }

  if (latestSamplesByProvider.size === 0) {
    return null;
  }

  const statuses = [...latestSamplesByProvider.values()];
  const errors = statuses.filter((status) => status === ProviderHealthSampleStatus.ERROR).length;
  const skipped = statuses.filter((status) => status === ProviderHealthSampleStatus.SKIPPED).length;
  const successful = statuses.filter((status) => status === ProviderHealthSampleStatus.SUCCESS).length;

  return {
    status: errors > 0
      ? 'review'
      : successful > 0
        ? 'online'
        : 'offline',
    providers: latestSamplesByProvider.size,
    errors,
    skipped,
  };
}

async function getLiveProviderInferenceStatus(): Promise<InferenceStatusSummary> {
  const modelRegistry = await LlmRuntimeService.listAvailableModels();
  const providerStatuses = modelRegistry.providers;
  const errorProviders = providerStatuses.filter((provider) => provider.status === 'error').length;
  const skippedProviders = providerStatuses.filter((provider) => provider.status === 'skipped').length;
  const successfulProviders = providerStatuses.filter((provider) => provider.status === 'success').length;

  return {
    status: errorProviders > 0
      ? 'review'
      : successfulProviders > 0
        ? 'online'
        : 'offline',
    providers: providerStatuses.length,
    errors: errorProviders,
    skipped: skippedProviders,
  };
}
