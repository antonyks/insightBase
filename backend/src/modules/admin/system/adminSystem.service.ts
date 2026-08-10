import { logger } from '../../../config/logger';
import { prisma } from '../../../config/database';
import { LlmRuntimeService } from '../../llm/llmRuntime.service';
import { UserRole, UserStatus } from '../../user/user.model';
import { JobQueueTransport } from '../../job';
import { getJobQueueTransport } from '../../job/jobQueue.client';
import { enqueueValidationJob } from '../../worker/validationJob';
import { AdminAnalyticsSummary, AdminSystemStatus } from './adminSystem.types';

const OFFLINE_INFERENCE_STATUS: AdminSystemStatus['inference'] = {
  status: 'offline',
  providers: 0,
  errors: 0,
  skipped: 0,
};

export const AdminSystemService = {
  async getAnalyticsSummary(): Promise<AdminAnalyticsSummary> {
    const [totalProviders, activeProviders, disabledProviders, totalUsers, activeUsers, bannedUsers, deletedUsers] =
      await Promise.all([
        prisma.llmProviderConfig.count({ where: { deletedAt: null } }),
        prisma.llmProviderConfig.count({ where: { deletedAt: null, enabled: true } }),
        prisma.llmProviderConfig.count({ where: { deletedAt: null, enabled: false } }),
        prisma.user.count({ where: { role: UserRole.USER } }),
        prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.ACTIVE } }),
        prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.BANNED } }),
        prisma.user.count({ where: { role: UserRole.USER, status: UserStatus.DELETED } }),
      ]);

    return {
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

    const modelRegistry = await LlmRuntimeService.listAvailableModels();
    const providerStatuses = modelRegistry.providers;
    const errorProviders = providerStatuses.filter((provider) => provider.status === 'error').length;
    const skippedProviders = providerStatuses.filter((provider) => provider.status === 'skipped').length;
    const successfulProviders = providerStatuses.filter((provider) => provider.status === 'success').length;
    const inferenceStatus = errorProviders > 0
      ? 'review'
      : successfulProviders > 0
        ? 'online'
        : 'offline';

    return {
      backend: {
        status: 'online',
      },
      database: {
        status: 'online',
      },
      inference: {
        status: inferenceStatus,
        providers: providerStatuses.length,
        errors: errorProviders,
        skipped: skippedProviders,
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
