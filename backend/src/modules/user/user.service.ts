import bcrypt from 'bcryptjs';
import { UserRepository } from './user.repository';
import { IUserCreateInput, IUserUpdate, IUserUpdatePassword } from './user.types';
import { DuplicateResourceError, NotFoundError, AuthenticationError } from '../../errors';
import { BCRYPT_SALT_ROUNDS } from '../../config/constants';
import { UserRole, UserStatus, SelectedUser, UserWhereInput, AuthUser } from './user.model';

export const UserService = {
  async createUser(data: IUserCreateInput): Promise<SelectedUser> {
    const existing = await UserRepository.findByEmail(data.email);
    if (existing) throw new DuplicateResourceError('Email already registered');

    const { password, ...userData } = data;

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    return await UserRepository.createUser({ ...userData, password: hashedPassword });
  },

  async getUserById(id: number): Promise<SelectedUser | null> {
    const user = await UserRepository.findById(id);
    if (!user) throw new NotFoundError('User not found');
    return user;
  },

  async getUsers(name?: string, skip?: number, take?: number): Promise<SelectedUser[]> {

    const baseFilter: UserWhereInput = {
      role: UserRole.USER,
      status: { not: UserStatus.DELETED }
    };

    let finalFilter: UserWhereInput = baseFilter;

    if (name) {
      finalFilter = {
        AND: [
          baseFilter,
          {
            name: {
              contains: name,
              mode: 'insensitive',
            }
          }
        ]
      };
    }

    return await UserRepository.findManyUsers(finalFilter, skip, take);
  },

  async updateUserById(id: number, data: IUserUpdate): Promise<SelectedUser | null> {
    const user = await UserRepository.updateUser(id, data);
    return user;
  },

  async updateUserPassword(data: IUserUpdatePassword): Promise<SelectedUser | null> {
    const user: AuthUser | null = (await UserRepository.findById(data.id, true)) as (AuthUser | null);

    if (!user)
      throw new NotFoundError("Account not found");

    const isValid = await bcrypt.compare(data.oldPassword, user.passwordHash);
    if (!isValid) throw new AuthenticationError("Incorrect old password");

    const hashedPassword = await bcrypt.hash(data.newPassword, BCRYPT_SALT_ROUNDS);

    const updatedUserData = await UserRepository.updateUserPassword(user.id, hashedPassword)
    return updatedUserData;
  },

  async deleteUserById(id: number): Promise<SelectedUser | null> {

    const user = await UserRepository.updateUserStatus(id, UserStatus.DELETED);
    return user;
  },

  async banUserById(id: number): Promise<SelectedUser | null> {


    const user = await UserRepository.updateUserStatus(id, UserStatus.BANNED);
    return user;
  },

  async activateUserById(id: number): Promise<SelectedUser | null> {
    const user = await UserRepository.updateUserStatus(id, UserStatus.ACTIVE);
    return user;
  },
};
