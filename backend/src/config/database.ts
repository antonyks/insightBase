import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient();

export async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected successfully');
  } catch (error :unknown) {
    if(error instanceof Error)
    logger.error(`❌ Database connection failed: ${error.message}`);
    process.exit(1);
  }
}

export { prisma };
