import { Request, Response } from 'express';
import { AuthenticatedRequest} from '../../types/authenticatedRequest'
import { UserService } from './user.service';
import { InvalidInputError } from '../../errors';
import { IUserUpdate, IUserUpdatePassword } from './user.types';
import { UserUpdateInput } from './user.model';

export const UserController = {
    async createUser(req: Request, res: Response): Promise<void> {
        const user = await UserService.createUser(req.body);
        res.status(201).json({ data: user });
        return;
    },

    async getAllUsers(req: Request, res: Response): Promise<void> {

        const { name, skip, take } = req.query;

        const searchName: string | undefined = typeof name === 'string' ? name : undefined;

        const paginationSkip: number | undefined = skip ? parseInt(skip as string, 10) : undefined;
        const paginationTake: number | undefined = take ? parseInt(take as string, 10) : undefined;

        if (paginationSkip !== undefined && (isNaN(paginationSkip) || paginationSkip < 0)) {
            throw new InvalidInputError("Invalid value for skip parameter");
        }
        if (paginationTake !== undefined && (isNaN(paginationTake) || paginationTake < 0)) {
            throw new InvalidInputError("Invalid value for take parameter");
        }


        const users = await UserService.getUsers(searchName, paginationSkip, paginationTake);
        res.status(200).json({ data: users });
        return;
    },

    async getUserById(req: Request, res: Response): Promise<void> {

        const idString: string = req.params.id;
        const id: number = parseInt(idString, 10);

        if (isNaN(id)) {
            throw new InvalidInputError(`The ID parameter '${idString}' is not a valid number.`)
        }

        const user = await UserService.getUserById(id);
        res.status(200).json({ data: user });
        return;
    },

    async updateUserById(req: Request, res: Response): Promise<void> {

        const idString: string = req.params.id;
        const id: number = parseInt(idString, 10);

        if (isNaN(id)) {
            throw new InvalidInputError(`The ID parameter '${idString}' is not a valid number.`)
        }

        const data: IUserUpdate = req.body;

        const user = await UserService.updateUserById(id, data);
        res.status(200).json({ data: user });
        return;
    },

    async getUserProfile(req: AuthenticatedRequest, res: Response): Promise<void> {

        if (req.user?.id) {
            const id: number = req.user.id;

            if (isNaN(id)) {
                throw new InvalidInputError(`The ID parameter '${id}' is not a valid number.`)
            }

            const user = await UserService.getUserById(id);
            res.status(200).json({ data: user });
            return;

        }

        throw new InvalidInputError("Invalid user id");
        
    },

    async updateUserPassword(req: AuthenticatedRequest, res: Response): Promise<void> {

        if (req.user) {

            const data: IUserUpdatePassword= {id:req.user.id,oldPassword:req.body.oldPassword, newPassword:req.body.newPassword}

            const user = await UserService.updateUserPassword(data);
            res.status(200).json({ data: user });
            return;

        }

        throw new InvalidInputError("Invalid user data");
        
    },

    async deleteUserById(req: Request, res: Response): Promise<void> {

        const idString: string = req.params.id;
        const id: number = parseInt(idString, 10);

        if (isNaN(id)) {
            throw new InvalidInputError(`The ID parameter '${idString}' is not a valid`)
        }

        const user = await UserService.deleteUserById(id);
        res.status(200).json({ data: user });
        return;
    },

    async banUserById(req: Request, res: Response): Promise<void> {

        const idString: string = req.params.id;
        const id: number = parseInt(idString, 10);

        if (isNaN(id)) {
            throw new InvalidInputError(`The ID parameter '${idString}' is not a valid`)
        }

        const user = await UserService.banUserById(id);
        res.status(200).json({ data: user });
        return;
    },

    async activateUserById(req: Request, res: Response): Promise<void> {

        const idString: string = req.params.id;
        const id: number = parseInt(idString, 10);

        if (isNaN(id)) {
            throw new InvalidInputError(`The ID parameter '${idString}' is not a valid`)
        }

        const user = await UserService.activateUserById(id);
        res.status(200).json({ data: user });
        return;
    },
};
