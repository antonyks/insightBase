import { mockPrisma } from '../setup';
import { UserRepository } from '../../modules/user/user.repository';
import { UserStatus, UserRole, SelectedUserFields, SelectedUser } from '../../modules/user/user.model';
import { selectUnknownFields } from 'express-validator/lib/field-selection';

describe('UserRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createUser', () => {
    it('should create a new user successfully', async () => {
      const userData = {
        email: 'test@example.com',
        password: 'hashedPassword',
        name: 'Test User',
      };

      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.create.mockResolvedValue(mockUser);

      const result = await UserRepository.createUser(userData);

      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          email: userData.email,
          passwordHash: userData.password,
          name: userData.name,
        },
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUser);
    });
  });

  describe('findByEmail', () => {
    it('should find user by email without password', async () => {
      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await UserRepository.findByEmail('test@example.com');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
        select: expect.any(Object),
      });

      expect(result).toEqual(mockUser);
    });

    it('should find user by email with password when includePassword is true', async () => {
      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await UserRepository.findByEmail('test@example.com', true);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com' },
        select: expect.objectContaining({ passwordHash: true }),
      });

      expect(result).toEqual(mockUser);
    });
  });

  describe('findById', () => {
    it('should find user by id without password', async () => {
      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await UserRepository.findById(1);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        select: expect.any(Object),
      });

      expect(result).toEqual(mockUser);
    });

    it('should find user by id with password when includePassword is true', async () => {
      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await UserRepository.findById(1, true);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        select: expect.objectContaining({ passwordHash: true }),
      });

      expect(result).toEqual(mockUser);
    });
  });

  describe('findManyUsers', () => {
    it('should find multiple users with filters', async () => {
      const mockUsers:SelectedUser[] = [
        {
          id: 1,
          email: 'test1@example.com',
          name: 'Test User 1',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          createdAt: new Date()
        },
        {
          id: 2,
          email: 'test2@example.com',
          name: 'Test User 2',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          createdAt: new Date(),
        },
      ];

      mockPrisma.user.findMany.mockResolvedValue(mockUsers);

      const result = await UserRepository.findManyUsers(
        { role: UserRole.USER },
        0,
        10
      );

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: { role: UserRole.USER },
        skip: 0,
        take: 10,
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUsers);
    });
  });

  describe('updateUser', () => {
    it('should update user successfully', async () => {
      const mockUser:SelectedUser = {
        id: 1,
        email: 'updated@example.com',
        name: 'Updated User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date()
      };

      mockPrisma.user.update.mockResolvedValue(mockUser);

      const result = await UserRepository.updateUser(1, { ...mockUser,name: 'updated' });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { ...mockUser,name: 'updated' },
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUser);
    });
  });

  describe('updateUserPassword', () => {
    it('should update user password successfully', async () => {
      const mockUser:SelectedUser = {
        id: 1,
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        createdAt: new Date(),
      };

      mockPrisma.user.update.mockResolvedValue(mockUser);

      const result = await UserRepository.updateUserPassword(1, 'newHashedPassword');

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { passwordHash: 'newHashedPassword' },
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUser);
    });
  });

  describe('updateUserStatus', () => {
    it('should update user status to DELETED and anonymize email', async () => {
      const mockUser:SelectedUser = {
        id: 1,
        email: 'deleted-test-uuid-123@forevergone.insight',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.DELETED,
        createdAt: new Date()
      };

      mockPrisma.user.update.mockResolvedValue(mockUser);

      const result = await UserRepository.updateUserStatus(1, UserStatus.DELETED);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          email: 'deleted-test-uuid-123@forevergone.insight',
          status: UserStatus.DELETED,
        },
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUser);
    });

    it('should update user status to BANNED', async () => {
      const mockUser:SelectedUser = {
        id: 1,
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.BANNED,
        createdAt: new Date(),
      };

      mockPrisma.user.update.mockResolvedValue(mockUser);

      const result = await UserRepository.updateUserStatus(1, UserStatus.BANNED);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: UserStatus.BANNED },
        select: SelectedUserFields,
      });

      expect(result).toEqual(mockUser);
    });
  });
});