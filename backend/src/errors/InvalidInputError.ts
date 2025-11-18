export class InvalidInputError extends Error {
  public statusCode: number = 400;

  constructor(message: string = 'Invalid input provided.') {
    super(message);
    this.name = 'InvalidInputError';
    Object.setPrototypeOf(this, InvalidInputError.prototype); 
  }
}