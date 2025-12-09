import { login } from '../../modules/auth/auth.controller';
import { mockPrisma } from '../setup';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { SelectedUserFields, UserRole, UserStatus } from '../../modules/user/user.model';
import * as AuthService from  '../../modules/auth/auth.service';
import { UserService } from '../../modules/user/user.service';
import { AuthenticationError, NotFoundError } from '../../errors';

describe('AuthController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('login', () => {
    it('should login user and return token', async () => {

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

      const req = {
        body: loginData,
      } as any;

      const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis()
      } as any;

      const mockAuthResult = {
        message: "Login successful",
        data: {
          user: {
            id: mockUser.id,
            email: mockUser.email,
            name: mockUser.name,
            role: mockUser.role,
            status: mockUser.status,
            createdAt: mockUser.createdAt,
            updatedAt: mockUser.updatedAt
          },
          token: 'test-jwt-token',
        }
      };

      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (jwt.sign as jest.Mock).mockReturnValue('test-jwt-token');

      await login(req, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(mockAuthResult);
    });

    it('should handle authentication error during login', async () => {
      const req = {
        body: {
          email: 'test@example.com',
          password: 'wrongpassword',
        },
      } as any;

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;

      mockPrisma.user.findUnique.mockResolvedValue(null);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      (jwt.sign as jest.Mock).mockReturnValue('test-jwt-token');

      await expect(login(req, mockRes)).rejects.toThrow(
        new NotFoundError("Account not found")
      );;

    });
  });

});