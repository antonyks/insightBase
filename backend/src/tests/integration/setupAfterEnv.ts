import { integrationPrisma } from './helpers/prisma';
import { jobNotificationListener } from '../../modules/job';

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'integration-test-uuid'),
}));

jest.mock('node-fetch', () => jest.fn((url: string | URL, init?: RequestInit) => fetch(url, init)));

afterAll(async () => {
  await jobNotificationListener.close();
  await integrationPrisma.$disconnect();
});
