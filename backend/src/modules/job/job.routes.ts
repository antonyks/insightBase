import { Router } from 'express';
import { authenticate } from '../../middleware';
import { JobController } from './job.controller';
import {
  handleValidationErrors,
  validateJobId,
} from './job.validation';

const router = Router();

router.use(authenticate);

router.get(
  '/:jobId',
  validateJobId,
  handleValidationErrors,
  JobController.getJob,
);

router.get(
  '/:jobId/stream',
  validateJobId,
  handleValidationErrors,
  JobController.streamJob,
);

router.post(
  '/:jobId/cancel',
  validateJobId,
  handleValidationErrors,
  JobController.cancelJob,
);

export default router;
