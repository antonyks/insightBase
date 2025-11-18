import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { AuthCredentials } from "./auth.types";
import { AuthUser } from '../user/user.model';
import { UserRepository } from '../user/user.repository';
import { NotFoundError } from '../../errors'

export const loginUser = async (data: AuthCredentials) => {
  const user:AuthUser|null = (await UserRepository.findByEmail(data.email,true)) as (AuthUser|null);

  if(!user)
    throw new NotFoundError("Account not found");

  const isValid = await bcrypt.compare(data.password, user.passwordHash);
  if (!isValid) throw new Error("Invalid credentials");

  const token = jwt.sign({ id: user.id, email:user.email,name:user.name, role:user.role, status:user.status }, process.env.JWT_SECRET || "secret", { expiresIn: "1d" });

  const { passwordHash, ...safeUser } = user;

  return { token, user: safeUser };
};
