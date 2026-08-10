import { NextFunction, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';

export const validateJobId = [
  param('jobId')
    .isInt({ min: 1 })
    .withMessage('Valid job ID is required'),
];

export const handleValidationErrors = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }
  next();
};
