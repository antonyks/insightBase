import { UserController } from '../../modules/user/user.controller';
import { UserService } from '../../modules/user/user.service';
import {  AuthenticationError, InvalidInputError } from '../../errors';
import { mockPrisma } from '../setup';
import { UserRole, UserStatus } from '../../modules/user/user.model';
import bcrypt from 'bcryptjs';

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashedPassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-123'),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test-jwt-token'),
}));





describe('UserController', () => {
    jest.mock('@prisma/client', () => {
  const original = jest.requireActual('@prisma/client');
  return {
    ...original,
    PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  };
});

   let req: Partial<Request>;
    let res: Partial<Response>;
    const mockUser = {
        id: 1,
        name: 'Test User',
        email: 'test@example.com',
        passwordHash: 'hashedPassword',
        status: UserStatus.ACTIVE,
        role: UserRole.USER,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(() => {
        req = {
        };
        const mockResponse = {
            json: jest.fn(),
            status: jest.fn(function (this: any) {
                return this;
            }),
        };
        res = mockResponse as unknown as Partial<Response>;
        
        jest.clearAllMocks();
    });

    describe('createUser', () => {
        it('should create a user and return 201 status', async () => {
            const userData = { name: mockUser.name, email: mockUser.email, password: 'password123' };
            req = {body:userData} as unknown as Partial<Request>;
            
            mockPrisma.user.create.mockResolvedValue(mockUser);
            
            await UserController.createUser(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });
    });

    describe('getAllUsers', () => {
        it('should get all users with pagination and return 200 status', async () => {
            req = {query:{ skip: '0', take: '10' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findMany.mockResolvedValue([mockUser]);
            
            await UserController.getAllUsers(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: [mockUser] });
        });

        it('should handle search name parameter', async () => {
            req = {query:{ name: 'Test', skip: '0', take: '10' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findMany.mockResolvedValue([mockUser]);
            
            await UserController.getAllUsers(req as any, res as any);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: [mockUser] });
        });

        it('should throw InvalidInputError for invalid skip parameter', async () => {
            req = {query:{skip: '-1', take: '10' }} as unknown as Partial<Request>;
            
            await expect(UserController.getAllUsers(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });

        it('should throw InvalidInputError for invalid take parameter', async () => {
            req = {query:{skip: '0', take: '-5' }} as unknown as Partial<Request>;
            
            await expect(UserController.getAllUsers(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('getUserById', () => {
        it('should get user by ID and return 200 status', async () => {
            req= {params : { id: '1' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            
            await UserController.getUserById(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError for invalid ID parameter', async () => {
            req= {params : { id: 'abc' }} as unknown as Partial<Request>;
            
            await expect(UserController.getUserById(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('updateUserById', () => {
        it('should update user by ID and return 200 status', async () => {
            req= {params :{ id: '1' }, body : { name: 'Updated User' }} as unknown as Partial<Request>;
            
            mockPrisma.user.update.mockResolvedValue(mockUser);
            
            await UserController.updateUserById(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError for invalid ID parameter', async () => {
          req= {params :{ id: 'abc' }, body : { name: 'Updated User' }} as unknown as Partial<Request>;
            
            await expect(UserController.updateUserById(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('getUserProfile', () => {
        it('should get user profile and return 200 status', async () => {
            req={user : { id: 1 }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            
            await UserController.getUserProfile(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError when user ID is invalid', async () => {
            req={user : {  id: NaN }} as unknown as Partial<Request>;
            
            await expect(UserController.getUserProfile(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });

        it('should throw InvalidInputError when user is not provided', async () => {
            
            await expect(UserController.getUserProfile(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('updateUserPassword', () => {
        it('should update user password and return 200 status', async () => {
            req={user : {id: 1 }, body : { oldPassword: 'oldpass', newPassword: 'newpass' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.user.update.mockResolvedValue(mockUser);
            
            await UserController.updateUserPassword(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError when user is not provided', async () => {
            req = {body:{ oldPassword: 'oldpass', newPassword: 'newpass' }} as unknown as Partial<Request>;
            
            await expect(UserController.updateUserPassword(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('deleteUserById', () => {
        it('should delete user by ID and return 200 status', async () => {
            req ={params :{ id: '1' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.user.update.mockResolvedValue(mockUser);
            
            await UserController.deleteUserById(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError for invalid ID parameter', async () => {
            req ={params :{ id: 'abc'}} as unknown as Partial<Request> ;
            
            await expect(UserController.deleteUserById(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('banUserById', () => {
        it('should ban user by ID and return 200 status', async () => {
            req ={params :{ id: '1' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.user.update.mockResolvedValue(mockUser);
            
            await UserController.banUserById(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError for invalid ID parameter', async () => {
            req ={params :{ id: 'abc'}} as unknown as Partial<Request> ;
            
            await expect(UserController.banUserById(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });

    describe('activateUserById', () => {
        it('should activate user by ID and return 200 status', async () => {
            req ={params :{ id: '1' }} as unknown as Partial<Request>;
            
            mockPrisma.user.findUnique.mockResolvedValue(mockUser);
            mockPrisma.user.update.mockResolvedValue(mockUser);
            
            await UserController.activateUserById(req as any, res as any);
            
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ data: mockUser });
        });

        it('should throw InvalidInputError for invalid ID parameter', async () => {
            req ={params :{ id: 'abc'}} as unknown as Partial<Request> ;
            
            await expect(UserController.activateUserById(req as any, res as any))
                .rejects.toThrow(InvalidInputError);
        });
    });


  describe('getProfile', () => {
    it('should get user profile', async () => {
      const req = {
        user: {
          id: 1,
          email: 'test@example.com',
          role: UserRole.USER,
        },
      } as any;

      const mockCreatedUser = {
              id: 1,
              email: 'test@example.com',
              name: 'Test User',
              role: UserRole.USER,
              status: UserStatus.ACTIVE,
              createdAt: new Date(),
              updatedAt: new Date(),
            };

    const mockRes = {
        json: jest.fn(),
        status: jest.fn().mockReturnThis(),
      } as any;

      mockPrisma.user.findUnique.mockResolvedValue(mockCreatedUser);

      await UserController.getUserProfile(req, mockRes);
      expect(mockRes.json).toHaveBeenCalledWith({data:mockCreatedUser});
    });
  });
});