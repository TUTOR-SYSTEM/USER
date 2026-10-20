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

  it('reports each missing password character class (shared policy codes)', () => {
    expect(messagesFor('abcdefg1!')).toEqual(['AUTH_PASSWORD_UPPERCASE']);
    expect(messagesFor('ABCDEFG1!')).toEqual(['AUTH_PASSWORD_LOWERCASE']);
    expect(messagesFor('Abcdefg!')).toEqual(['AUTH_PASSWORD_DIGIT']);
    expect(messagesFor('Abcdefg1')).toEqual(['AUTH_PASSWORD_SPECIAL']);
  });

  it('reports every failing rule at once', () => {
    expect(messagesFor('abcdefgh')).toEqual([
      'AUTH_PASSWORD_UPPERCASE',
      'AUTH_PASSWORD_DIGIT',
      'AUTH_PASSWORD_SPECIAL',
    ]);
  });

  it('accepts the 8-100 length window with the complexity rules and rejects outside it', () => {
    expect(messagesFor('Abcdef1!')).toEqual([]);
    expect(messagesFor(`Abcdef1!${'x'.repeat(92)}`)).toEqual([]);
    expect(messagesFor('Abc1!')).toEqual(['AUTH_PASSWORD_MIN']);
    expect(messagesFor(`Abcdef1!${'x'.repeat(93)}`)).toEqual(['AUTH_PASSWORD_MAX']);
  });
});
