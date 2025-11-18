import { Router } from 'express';
import { UserController } from './user.controller';
import { authenticate, authorizeRoles } from '../../middleware'
import { UserRole } from '../user/user.model'
import { handleValidationErrors, validateBanActivate, validateChangePassword, validateCreateUser, validateSearch, validateUpdateUser, validateUserId } from './user.validation';


const router = Router();


router.get('/profile', 
    authenticate, 
    UserController.getUserProfile
);

router.post('/', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateCreateUser,
  handleValidationErrors,
  UserController.createUser
);

router.get('/', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateSearch,
  handleValidationErrors,
  UserController.getAllUsers
);

router.get('/:id', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateUserId,
  handleValidationErrors,
  UserController.getUserById
);

router.put('/:id', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateUserId,
  validateUpdateUser,
  handleValidationErrors,
  UserController.updateUserById
);

router.delete('/:id', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateUserId,
  handleValidationErrors,
  UserController.deleteUserById
);

router.post('/ban/:id', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateBanActivate,
  handleValidationErrors,
  UserController.banUserById
);

router.post('/activate/:id', 
  authenticate,
  authorizeRoles(UserRole.ADMIN),
  validateBanActivate,
  handleValidationErrors,
  UserController.activateUserById
);

router.post('/change-password', 
  authenticate,
  validateChangePassword,
  handleValidationErrors,
  UserController.updateUserPassword
);

export default router;
