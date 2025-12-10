import { IUserCreateInput } from './user.types';
import { UserModel, SelectedUser, AuthUser, UserUpdateInput, UserWhereInput, UserStatus, SelectedUserFields } from './user.model';
import { Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

function generateDeletedEmail(): string {
    const uniqueId = uuidv4(); 
    
    const anonymizedEmail = `deleted-${uniqueId}@forevergone.insight`;

    return anonymizedEmail;
}



export const UserRepository = {


  async createUser(userData: IUserCreateInput): Promise<SelectedUser> {

    return UserModel.create({
      data: {
        email: userData.email,
        passwordHash: userData.password,
        name: userData.name,
      },
      select: SelectedUserFields
    });
  },

  async findByEmail(email: string, includePassword: boolean = false): Promise<SelectedUser | AuthUser | null> {

    let selection: Prisma.UserSelect = SelectedUserFields;

    if (includePassword) {
      selection = {
        ...SelectedUserFields,
        passwordHash: true
      } as Prisma.UserSelect;
    }

    return UserModel.findUnique({ where: { email:email, NOT:{status:UserStatus.DELETED} }, select: selection });
  },

  async findById(id: number, includePassword: boolean = false): Promise<SelectedUser | null> {
    let selection: Prisma.UserSelect = SelectedUserFields;

    if (includePassword) {
      selection = {
        ...SelectedUserFields,
        passwordHash: true
      } as Prisma.UserSelect;
    }

    return UserModel.findUnique({
      where: { id }, select: selection
    });
  },

  async findManyUsers(where?: UserWhereInput, skip?: number, take?: number): Promise<SelectedUser[]> {
    return UserModel.findMany({
      where: where,
      skip: skip,
      take: take,
      select: SelectedUserFields
    });
  },

  async updateUser(id: number, data: UserUpdateInput): Promise<SelectedUser | null> {
    return UserModel.update({
      where: { id }, data: data,
      select: SelectedUserFields
    });
  },

  async updateUserPassword(id: number, newHashedPassword: string): Promise<SelectedUser | null> {
    return UserModel.update({
      where: { id }, data: { passwordHash: newHashedPassword },
      select: SelectedUserFields
    });
  },

  async updateUserStatus(id: number, newStatus: UserStatus): Promise<SelectedUser | null> {


    if (newStatus == UserStatus.DELETED) {
      const email = generateDeletedEmail();
      return UserModel.update({
        where: { id }, data: { email: email, status: newStatus },
        select: SelectedUserFields
      });
    }

    return UserModel.update({
      where: { id }, data: { status: newStatus },
      select: SelectedUserFields
    });
  },

};
