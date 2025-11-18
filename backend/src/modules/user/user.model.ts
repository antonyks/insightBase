import { prisma } from '../../config/database';
import { Prisma, User, UserStatus, UserRole } from '@prisma/client';

export {UserStatus, UserRole}

export const UserModel = prisma.user;
export type { User };


const userSelection = { 
    id: true, 
    name: true, 
    email: true, 
    role: true,
    status: true,
    createdAt: true 
} as const;

type SelectedUser = Prisma.UserGetPayload<{ 
  select: typeof userSelection 
}>;

const authSelection = { 
    ...userSelection, 
    passwordHash: true 
} as const;

type AuthUser = Prisma.UserGetPayload<{ 
  select: typeof authSelection 
}>;

export type { SelectedUser, AuthUser};
export const SelectedUserFields = userSelection;

const userUpdate = { 
    name: true, 
    email: true
} as const;

type UserUpdateInput = Prisma.UserGetPayload<{ 
  select: typeof userUpdate 
}>;

export type { UserUpdateInput };

export type UserWhereInput = Prisma.UserWhereInput;
export type UserCreateInput = Prisma.UserCreateInput;