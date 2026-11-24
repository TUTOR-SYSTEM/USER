import { generateRandomPassword } from '@packages/helpers/generate.helper';
import { managedPasswordSchema, newPasswordSchema } from '@packages/entities/auth/password.schema';

describe('generateRandomPassword', () => {
  it('is 10 characters by default and passes every password rule', () => {
    for (let i = 0; i < 500; i++) {
      const password = generateRandomPassword();
      expect(password).toHaveLength(10);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
      expect(newPasswordSchema.safeParse(password).success).toBe(true);
      expect(managedPasswordSchema.safeParse(password).success).toBe(true);
    }
  });

  it('is different on every call', () => {
    const set = new Set(Array.from({ length: 50 }, () => generateRandomPassword()));
    expect(set.size).toBe(50);
  });
});
