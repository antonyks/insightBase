import { errorHandler } from '../../middleware/errorHandler'
import { NotFoundError, AuthenticationError , DuplicateResourceError } from '../../errors';

describe('errorHandler', () => {
  it('should handle NotFoundError', () => {
    const error = new NotFoundError('Resource not found');
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    errorHandler(error, {} as any, mockRes, {} as any);


    console.log(mockRes.json)

    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Resource not found',
    });
  });

  it('should handle AuthenticationError', () => {
    const error = new AuthenticationError('Invalid credentials');
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    errorHandler(error, {} as any, mockRes, {} as any);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Invalid credentials',
    });
  });


  it('should handle DuplicateResourceError', () => {
    const error = new DuplicateResourceError('Email already exists');
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    errorHandler(error, {} as any, mockRes, {} as any);

    expect(mockRes.status).toHaveBeenCalledWith(409);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Email already exists',
    });
  });

  it('should handle generic error', () => {
    const error = new Error('Internal server error');
    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;

    errorHandler(error, {} as any, mockRes, {} as any);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Internal server error',
    });
  });
});