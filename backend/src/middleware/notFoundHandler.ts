import { Request, Response, NextFunction } from 'express';

export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({
    message: `Route ${req.originalUrl} not found`
  });
  return;
}
