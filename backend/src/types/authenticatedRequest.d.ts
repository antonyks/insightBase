import { JwtPayload } from 'jsonwebtoken';
import { SelectedUser } from '../modules/user/user.model';
import { Request, Response, NextFunction } from 'express';


export interface AuthenticatedRequest extends Request {
  user?: JwtPayload & SelectedUser;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & SelectedUser;
    }
  }
}

// declare module 'express' {
//   interface Request {
//     user?: JwtPayload & SelectedUser; 
//   }
// }
