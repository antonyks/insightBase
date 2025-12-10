import { Router } from "express";
import * as AuthController from "./auth.controller";
import { validateLogin, handleValidationErrors } from "./auth.validation"

const router = Router();

router.post("/login", 
    validateLogin,
    handleValidationErrors,
    AuthController.login
);

export default router;
