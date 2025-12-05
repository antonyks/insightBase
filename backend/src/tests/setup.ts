import { PrismaClient } from '@prisma/client';
import { jest } from '@jest/globals';
import { SelectedUser } from '../modules/user/user.model';

type UserCreateResult = Awaited<ReturnType<PrismaClient['user']['create']>>;

const mockPrisma = {
  user: {
    create: jest.fn<() => Promise<UserCreateResult>>(),
    findUnique: jest.fn<() => Promise<SelectedUser | null>>(),
    findMany: jest.fn<() => Promise<SelectedUser[]>>(),
    update: jest.fn<() => Promise<SelectedUser>>(),
  },
};


jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  UserStatus: {
    ACTIVE: 'ACTIVE',
    BANNED: 'BANNED',
    DELETED: 'DELETED',
  },
  UserRole: {
    USER: 'USER',
    ADMIN: 'ADMIN',
  },
}));


jest.mock('bcryptjs', () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));


jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-123'),
}));


jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
}));

beforeEach(() => {
    mockPrisma.user.create.mockClear();
    mockPrisma.user.findUnique.mockClear();
    mockPrisma.user.findMany.mockClear();
    mockPrisma.user.update.mockClear();
});

export { mockPrisma };