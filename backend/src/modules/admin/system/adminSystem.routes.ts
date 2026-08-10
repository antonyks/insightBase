import { Router } from 'express';
import { authenticate, authorizeRoles } from '../../../middleware';
import { UserRole } from '../../user/user.model';
import { AdminSystemController } from './adminSystem.controller';

const router = Router();

router.use(authenticate, authorizeRoles(UserRole.ADMIN));

router.get('/analytics/summary', AdminSystemController.getAnalyticsSummary);
router.get('/system/status', AdminSystemController.getSystemStatus);
router.post('/system/validation-jobs', AdminSystemController.createValidationJob);

export default router;
