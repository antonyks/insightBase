import { Response } from 'express';
import { InvalidInputError } from '../../../errors';
import { AuthenticatedRequest } from '../../../types/authenticatedRequest';
import { AdminSystemService } from './adminSystem.service';

export const AdminSystemController = {
  async getAnalyticsSummary(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const summary = await AdminSystemService.getAnalyticsSummary();
    res.status(200).json({ data: summary });
  },

  async getSystemStatus(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const status = await AdminSystemService.getSystemStatus();
    res.status(200).json({ data: status });
  },

  async createValidationJob(req: AuthenticatedRequest, res: Response): Promise<void> {
    const workspaceId = req.workspace?.id;
    const createdByUserId = req.user?.id;

    if (!workspaceId) {
      throw new InvalidInputError('Workspace context is required');
    }

    if (!createdByUserId) {
      throw new InvalidInputError('Authenticated user context is required');
    }

    const job = await AdminSystemService.enqueueValidationJob({
      workspaceId,
      createdByUserId,
      mode: req.body?.mode,
    });

    res.status(202).json({ data: job });
  },
};
