export class AuthenticationError extends Error {
  constructor(message: string = 'Unauthorized') {
    super(message);
        this.name = 'Unauthorized';
        Object.setPrototypeOf(this, AuthenticationError.prototype); 
  }
}