import {
  changePasswordSchema,
  createUserSchema,
  dataFieldSchema,
  getUsersQuerySchema,
  updateGradeSchema,
  updateUserGradesSchema,
  updateUserSchema,
} from 'src/packages/entities/user/user.schema';

const UUID = '11111111-1111-4111-8111-111111111111';

const messagesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : result.error!.issues.map((i) => i.message);

describe('user schemas', () => {
  describe('getUsersQuerySchema', () => {
    it('applies page=1 and limit=10 defaults', () => {
      expect(getUsersQuerySchema.parse({})).toEqual({ page: 1, limit: 10 });
    });

    it('maps the legacy pageSize to limit when limit is absent', () => {
      expect(getUsersQuerySchema.parse({ pageSize: '25' })).toMatchObject({ limit: 25 });
    });

    it('prefers an explicit limit over pageSize', () => {
      expect(getUsersQuerySchema.parse({ limit: '5', pageSize: '25' })).toMatchObject({ limit: 5 });
    });

    it.each([
      ['page 0', { page: 0 }],
      ['limit 0', { limit: 0 }],
      ['limit 101', { limit: 101 }],
      ['non-integer page', { page: 1.5 }],
      ['unknown role', { role: 'ROOT' }],
      ['isActive other than true/false', { isActive: 'yes' }],
    ])('rejects %s', (_label, input) => {
      expect(getUsersQuerySchema.safeParse(input).success).toBe(false);
    });

    it('turns isActive "true"/"false" into booleans', () => {
      expect(getUsersQuerySchema.parse({ isActive: 'true' }).isActive).toBe(true);
      expect(getUsersQuerySchema.parse({ isActive: 'false' }).isActive).toBe(false);
    });

    it('trims search and rejects an empty search after trimming', () => {
      expect(getUsersQuerySchema.parse({ search: '  an  ' }).search).toBe('an');
      expect(getUsersQuerySchema.safeParse({ search: '   ' }).success).toBe(false);
    });
  });

  describe('changePasswordSchema', () => {
    const valid = (newPassword: string, currentPassword = 'old') =>
      changePasswordSchema.safeParse({ currentPassword, newPassword });

    it('accepts a password meeting every rule', () => {
      expect(valid('Abcdef1!').success).toBe(true);
    });

    it('accepts both length boundaries (8 and 100) and rejects 7 and 101', () => {
      expect(valid('Abcdef1!').success).toBe(true);
      expect(valid(`Abcdef1!${'x'.repeat(92)}`).success).toBe(true);
      expect(valid('Abcde1!').success).toBe(false);
      expect(valid(`Abcdef1!${'x'.repeat(93)}`).success).toBe(false);
    });

    it.each([
      ['no lowercase', 'ABCDEF1!', 'AUTH_PASSWORD_LOWERCASE'],
      ['no uppercase', 'abcdef1!', 'AUTH_PASSWORD_UPPERCASE'],
      ['no digit', 'Abcdefg!', 'AUTH_PASSWORD_DIGIT'],
      ['no special character', 'Abcdefg1', 'AUTH_PASSWORD_SPECIAL'],
    ])('reports the missing rule when there is %s', (_label, password, code) => {
      expect(messagesOf(valid(password))).toContain(code);
    });

    it('requires a non-empty current password', () => {
      expect(
        changePasswordSchema.safeParse({ currentPassword: '', newPassword: 'Abcdef1!' }).success,
      ).toBe(false);
    });

    it('accepts a current password shorter than the new-password minimum (legacy accounts)', () => {
      expect(valid('Abcdef1!', 'abc').success).toBe(true);
    });

    it('rejects a new password equal to the current one', () => {
      expect(messagesOf(valid('Abcdef1!', 'Abcdef1!'))).toEqual(['NEW_PASSWORD_MUST_DIFFER']);
    });

    it('does not stack complexity messages when the length rule already failed', () => {
      expect(messagesOf(valid('abc'))).toEqual(['AUTH_PASSWORD_MIN']);
    });
  });

  describe('dataFieldSchema', () => {
    it('requires non-empty field and value strings', () => {
      expect(dataFieldSchema.safeParse({ field: 'email', value: 'a@b.c' }).success).toBe(true);
      expect(dataFieldSchema.safeParse({ field: '', value: 'x' }).success).toBe(false);
      expect(dataFieldSchema.safeParse({ field: 'email', value: '' }).success).toBe(false);
    });
  });

  describe('updateUserGradesSchema', () => {
    it('accepts a non-empty array of uuids', () => {
      expect(updateUserGradesSchema.safeParse({ gradesId: [UUID] }).success).toBe(true);
    });

    it('rejects an empty array and non-uuid entries', () => {
      expect(updateUserGradesSchema.safeParse({ gradesId: [] }).success).toBe(false);
      expect(updateUserGradesSchema.safeParse({ gradesId: ['nope'] }).success).toBe(false);
    });
  });

  describe('updateGradeSchema', () => {
    it('trims the name and coerces the level', () => {
      expect(updateGradeSchema.parse({ name: '  Lop 5 ', level: '5' })).toEqual({
        name: 'Lop 5',
        level: 5,
      });
    });

    it.each([
      ['empty name', { name: '   ', level: 1 }],
      ['name over 50 chars', { name: 'x'.repeat(51), level: 1 }],
      ['level 0', { name: 'A', level: 0 }],
      ['level 13', { name: 'A', level: 13 }],
      ['non-integer level', { name: 'A', level: 2.5 }],
    ])('rejects %s', (_label, input) => {
      expect(updateGradeSchema.safeParse(input).success).toBe(false);
    });

    it('accepts both level bounds 1 and 12', () => {
      expect(updateGradeSchema.safeParse({ name: 'A', level: 1 }).success).toBe(true);
      expect(updateGradeSchema.safeParse({ name: 'A', level: 12 }).success).toBe(true);
    });
  });

  describe('updateUserSchema', () => {
    it('accepts an empty object (every field optional)', () => {
      expect(updateUserSchema.safeParse({}).success).toBe(true);
    });

    it('rejects unknown keys (strict), so password cannot slip through', () => {
      expect(updateUserSchema.safeParse({ password: 'x' }).success).toBe(false);
      expect(updateUserSchema.safeParse({ unknownField: 1 }).success).toBe(false);
    });

    it.each([
      ['invalid email', { email: 'nope' }],
      ['firstName of 1 char', { firstName: 'A' }],
      ['lastName over 100 chars', { lastName: 'x'.repeat(101) }],
      ['avatar not a url', { avatar: 'not-a-url' }],
      ['phone over 20 chars', { phone: '1'.repeat(21) }],
      ['userCode over 6 chars', { userCode: '1234567' }],
      ['unknown gender', { gender: 'X' }],
      ['gradesId not uuids', { gradesId: ['x'] }],
      ['parentId not uuid', { parentId: 'x' }],
      ['tutorId not uuid', { tutorId: 'x' }],
      ['role outside enum', { role: 'ROOT' }],
    ])('rejects %s', (_label, input) => {
      expect(updateUserSchema.safeParse(input).success).toBe(false);
    });

    it('allows explicit null for nullable columns', () => {
      expect(
        updateUserSchema.safeParse({
          avatar: null,
          phone: null,
          description: null,
          dateOfBirth: null,
          parentId: null,
          tutorId: null,
        }).success,
      ).toBe(true);
    });

    it('trims firstName and coerces dateOfBirth', () => {
      const out = updateUserSchema.parse({ firstName: '  Ann ', dateOfBirth: '2010-01-02' });
      expect(out.firstName).toBe('Ann');
      expect(out.dateOfBirth).toBeInstanceOf(Date);
    });
  });

  describe('createUserSchema', () => {
    const base = {
      email: 'new@example.com',
      firstName: 'Ann',
      lastName: 'Lee',
      password: 'Abcdef1!',
    };

    it('applies defaults for optional columns', () => {
      const out = createUserSchema.parse(base);
      expect(out).toMatchObject({
        isActive: true,
        description: '',
        userCode: '',
        address: '',
        gradesId: [],
        role: 'STUDENT',
        relationship: '',
      });
    });

    it('requires email, firstName, lastName and password', () => {
      expect(createUserSchema.safeParse({ ...base, email: '' }).success).toBe(false);
      expect(createUserSchema.safeParse({ ...base, firstName: 'A' }).success).toBe(false);
      expect(createUserSchema.safeParse({ ...base, lastName: 'B' }).success).toBe(false);
      expect(createUserSchema.safeParse({ ...base, password: undefined }).success).toBe(false);
    });

    it('enforces the 6..20 length window on password', () => {
      expect(createUserSchema.safeParse({ ...base, password: 'Ab1!x' }).success).toBe(false);
      expect(createUserSchema.safeParse({ ...base, password: 'A'.repeat(21) }).success).toBe(false);
    });

    it('requires all four character classes once the password is 8+ chars', () => {
      expect(messagesOf(createUserSchema.safeParse({ ...base, password: 'abcdefg1!' }))).toEqual([
        'AUTH_PASSWORD_UPPERCASE',
      ]);
      expect(messagesOf(createUserSchema.safeParse({ ...base, password: 'Abcdefgh!' }))).toEqual([
        'AUTH_PASSWORD_DIGIT',
      ]);
      expect(messagesOf(createUserSchema.safeParse({ ...base, password: 'Abcdefgh1' }))).toEqual([
        'AUTH_PASSWORD_SPECIAL',
      ]);
    });

    it('uses the same 8-100 policy as change-password: a 6-character password is refused', () => {
      expect(createUserSchema.safeParse({ ...base, password: 'Abcde1!' }).success).toBe(false);
      expect(
        changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'Abcde1!' }).success,
      ).toBe(false);
      expect(createUserSchema.safeParse({ ...base, password: 'Abcdef1!' }).success).toBe(true);
    });

    it('rejects a self-chosen role outside the enum and accepts ADMIN/TUTOR/PARENT/STUDENT', () => {
      expect(createUserSchema.safeParse({ ...base, role: 'ROOT' }).success).toBe(false);
      for (const role of ['ADMIN', 'TUTOR', 'PARENT', 'STUDENT']) {
        expect(createUserSchema.safeParse({ ...base, role }).success).toBe(true);
      }
    });

    it('limits relationship to MOTHER, FATHER or empty', () => {
      expect(createUserSchema.safeParse({ ...base, relationship: 'GUARDIAN' }).success).toBe(false);
      expect(createUserSchema.safeParse({ ...base, relationship: 'MOTHER' }).success).toBe(true);
    });

    it('validates gradesId entries as uuids', () => {
      expect(createUserSchema.safeParse({ ...base, gradesId: [UUID] }).success).toBe(true);
      expect(createUserSchema.safeParse({ ...base, gradesId: ['x'] }).success).toBe(false);
    });

    it('rejects an invalid email', () => {
      expect(createUserSchema.safeParse({ ...base, email: 'bad' }).success).toBe(false);
    });
  });
});
