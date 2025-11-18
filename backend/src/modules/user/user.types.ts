import { UserRole } from "./user.model"

export interface IUser {
  id: string;
  name: string;
  email: string;
  password: string;
  userRole: UserRole;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IUserCreateInput {
  name: string;
  email: string;
  password: string;
}

export interface IUserResponse {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface IUserUpdate {
  name: string;
  email: string;
}

export interface IUserUpdatePassword {
  id: number;
  oldPassword: string;
  newPassword: string;
}


