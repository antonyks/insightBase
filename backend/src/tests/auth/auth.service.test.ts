import { loginUser } from '../../modules/auth/auth.service';
import { mockPrisma } from '../setup';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AuthenticationError } from '../../errors';
import { SelectedUserFields, UserRole, UserStatus } from '../../modules/user/user.model';

jest.mock('bcryptjs');
jest.mock('jsonwebtoken');

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    it('should authenticate user and return JWT token', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'password123',
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

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (jwt.sign as jest.Mock).mockReturnValue('test-jwt-token');

      const result = await loginUser(loginData);

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email:loginData.email }, 
        select: {...SelectedUserFields,passwordHash: true}
    });
      expect(bcrypt.compare).toHaveBeenCalledWith(loginData.password, 'hashedPassword');
      expect(jwt.sign).toHaveBeenCalledWith(
        { id: 1, email: mockUser.email, name:mockUser.name, status:mockUser.status, role: mockUser.role    },
        process.env.JWT_SECRET || 'secret',
        { expiresIn: '1d' }
      );
      expect(result).toEqual({
        user: {
          id: 1,
          email: 'test@example.com',
          name: 'Test User',
          role: mockUser.role,
          status: mockUser.status,
          createdAt:mockUser.createdAt,
          updatedAt:mockUser.updatedAt
        },
        token: 'test-jwt-token',
      });
    });

    it('should throw AuthenticationError for invalid credentials', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'password123',
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

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(loginUser(loginData)).rejects.toThrow(
        new AuthenticationError('Invalid credentials')
      );
    });

    it('should throw AuthenticationError for non-existent user', async () => {
      const loginData = {
        email: 'nonexistent@example.com',
        password: 'password123',
      };

      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(loginUser(loginData)).rejects.toThrow(
        new AuthenticationError('Account not found')
      );
    });

    it('should throw AuthenticationError for banned user', async () => {
      const loginData = {
        email: 'test@example.com',
        password: 'password123',
      };

      const mockUser = {
        id: 1,
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        name: 'Test User',
        role: UserRole.USER,
        status: UserStatus.BANNED,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(loginUser(loginData)).rejects.toThrow(
        new AuthenticationError('Account is banned')
      );
    });
  });


});