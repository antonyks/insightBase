export class DuplicateResourceError extends Error {
    constructor(message: string= 'Duplicate resource found') {
        super(message);
        this.name = 'DuplicateResourceError';
        Object.setPrototypeOf(this, DuplicateResourceError.prototype); 
    }
}