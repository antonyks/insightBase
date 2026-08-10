import { Router } from 'express';
import userRoutes from './user/user.routes';
import authRoutes from './auth/auth.routes';
import chatRoutes from './chat/chat.routes';
import adminLlmRoutes from './admin/llm/llmProvider.routes';
import adminSystemRoutes from './admin/system/adminSystem.routes';
import adminWorkspaceRoutes from './admin/workspace/adminWorkspace.routes';
import llmRoutes from './llm/llm.routes';
import workspaceRoutes from './workspace/workspace.routes';
import jobRoutes from './job/job.routes';

export const router = Router();

router.use('/users', userRoutes);
router.use('/auth', authRoutes);
router.use('/chat',chatRoutes);
router.use('/llm', llmRoutes);
router.use('/workspaces', workspaceRoutes);
router.use('/jobs', jobRoutes);
router.use('/admin', adminWorkspaceRoutes);
router.use('/admin', adminSystemRoutes);
router.use('/admin/llm', adminLlmRoutes);
