import dotenv from 'dotenv';
dotenv.config();
import app from './app';
import { connectDatabase, prisma } from './config/database';
import { logger } from './config/logger';
import { startJobQueueClient, stopJobQueueClient } from './modules/job/jobQueue.client';

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDatabase();
    await startJobQueueClient();
    const server = app.listen(PORT, () => logger.info(`🚀 Server running on port ${PORT}`));
    server.timeout = 0;
    server.requestTimeout = 0;

    async function shutdown(): Promise<void> {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        await stopJobQueueClient();
        await prisma.$disconnect();
        process.exit(0);
      } catch (error: unknown) {
        logger.error({ err: error }, 'Failed to shut down server cleanly.');
        process.exit(1);
      }
    }

    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
  } catch (error:unknown) {
    if(error instanceof Error)
    logger.error(`❌ Failed to start server: ${error.message}`);
    await stopJobQueueClient().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  }
}

startServer();
