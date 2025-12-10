import { Request, Response } from "express";
import * as AuthService from "./auth.service";


export const login = async (req: Request, res: Response) => {
    const result = await AuthService.loginUser(req.body);
    res.status(200).json({ message: "Login successful", data: result });
};
