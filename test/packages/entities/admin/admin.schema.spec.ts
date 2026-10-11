import { createManagedUserSchema } from 'src/packages/entities/admin/admin.schema';

const base = {
  email: 'tutor@example.test',
  firstName: 'An',
  lastName: 'Le',
  password: 'Abcdef1!',
};

const messagesFor = (password: string) => {
  const result = createManagedUserSchema.safeParse({ ...base, password });
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('createManagedUserSchema', () => {
  it('accepts a valid payload and defaults isActive to true', () => {
    const parsed = createManagedUserSchema.parse(base);
    expect(parsed.isActive).toBe(true);
    expect(parsed.email).toBe(base.email);
  });

  it('rejects unknown keys (role is forced by the endpoint, never taken from the body)', () => {
    expect(createManagedUserSchema.safeParse({ ...base, role: 'ADMIN' }).success).toBe(false);
  });

  it('coerces dateOfBirth into a Date', () => {
    const parsed = createManagedUserSchema.parse({ ...base, dateOfBirth: '2010-05-01' });
    expect(parsed.dateOfBirth).toBeInstanceOf(Date);
  });

  it('reports each missing password character class for an 8-14 char password', () => {
    expect(messagesFor('ABCDEF1!')).toEqual([
      'Password must include at least one lowercase letter (a-z)',
    ]);
    expect(messagesFor('abcdef1!')).toEqual([
      'Password must include at least one uppercase letter (A-Z)',
    ]);
    expect(messagesFor('Abcdefg!')).toEqual(['Password must include at least one digit (0-9)']);
    expect(messagesFor('Abcdefg1')).toEqual([
      'Password must include at least one special character',
    ]);
  });

  it('reports every failing rule at once', () => {
    expect(messagesFor('abcdefgh')).toEqual([
      'Password must include at least one uppercase letter (A-Z)',
      'Password must include at least one digit (0-9)',
      'Password must include at least one special character',
    ]);
  });

  it('skips the complexity rules outside the 8-14 char window (base 6-20 rule still applies)', () => {
    expect(messagesFor('abcdef')).toEqual([]);
    expect(messagesFor('abcdefghijklmno')).toEqual([]);
  });

  it('enforces the base password length bounds', () => {
    expect(messagesFor('Ab1!')).toEqual(['Password must be at least 6 characters']);
    expect(messagesFor('Abcdefghijklmnopqrs1!')).toEqual([
      'Password must be at most 20 characters',
    ]);
  });
});
