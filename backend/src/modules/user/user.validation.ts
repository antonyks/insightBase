import { body, param, query, validationResult } from 'express-validator';
import { Request, Response } from 'express';

export const validateCreateUser = [
  body('name')
    .isLength({ min: 1 })
    .withMessage('Name is required')
    .trim(),
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long')
];


export const validateUpdateUser = [
  body('name')
    .optional()
    .isLength({ min: 1 })
    .withMessage('Name must be at least 1 character long')
    .trim(),
  body('email')
    .optional()
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required')
];


export const validateUpdatePassword = [
  body('oldPassword')
    .isLength({ min: 1 })
    .withMessage('Old password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
];


export const validateUserId = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Valid user ID is required')
];


export const validateSearch = [
  query('name')
    .optional()
    .isLength({ min: 1 })
    .withMessage('Search name must be at least 1 character long')
    .trim(),
  query('skip')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Skip must be a non-negative integer'),
  query('take')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Take must be a positive integer')
];


export const validateBanActivate = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('Valid user ID is required')
];


export const validateChangePassword = [
  body('oldPassword')
    .isLength({ min: 1 })
    .withMessage('Old password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
];


export const handleValidationErrors = (req: Request, res: Response, next: Function) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array()
    });
  }
  next();
};