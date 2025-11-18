import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';
import { DuplicateResourceError, NotFoundError, InvalidInputError, AuthenticationError } from '../errors';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {

    switch (true) {
        case (err instanceof DuplicateResourceError):
            res.status(409).json({ message: err.message });
            return;
        case (err instanceof NotFoundError):
            res.status(404).json({ message: err.message });
            return;
        case (err instanceof InvalidInputError):
            res.status(400).json({ message: err.message });
            return;
        case (err instanceof AuthenticationError):
            res.status(401).json({ message: err.message });
            return;
        case (err instanceof Error):
            logger.error(err.message);
            const status = 500;
            res.status(status).json({
                message: err.message || 'Internal server error'
            });
            return;
        default:
            logger.error(`Unknown, non-Error object thrown in error handler: ${JSON.stringify(err as any)}`);
            res.status(500).json({
                message: (err as any)?.message || 'An unexpected error occurred.'
            });
            return;

    }

}
