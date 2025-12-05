import { BCRYPT_SALT_ROUNDS } from '../../config/constants';

describe('constants', () => {
  it('should have correct BCRYPT_SALT_ROUNDS value', () => {
    expect(BCRYPT_SALT_ROUNDS).toBe(10);
  });
});