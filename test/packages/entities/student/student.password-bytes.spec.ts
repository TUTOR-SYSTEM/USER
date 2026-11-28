import { studentPasswordSchema } from 'src/packages/entities/student/student.schema';

/** F-16: bcrypt reads only 72 bytes, so the student/parent password schema must cap bytes too. */
describe('studentPasswordSchema byte limit (F-16)', () => {
  it('accepts exactly 72 ASCII bytes', () => {
    expect(studentPasswordSchema.safeParse(`Abcdef1!${'x'.repeat(64)}`).success).toBe(true);
  });

  it('rejects 73 ASCII bytes', () => {
    expect(studentPasswordSchema.safeParse(`Abcdef1!${'x'.repeat(65)}`).success).toBe(false);
  });

  it('rejects a password under 72 characters whose UTF-8 bytes exceed 72', () => {
    // 36 two-byte characters = 72 bytes; add one more two-byte char -> 74 bytes, 37 chars.
    const pw = `Abcdef1!${'é'.repeat(65)}`;
    expect(Buffer.byteLength(pw, 'utf8')).toBeGreaterThan(72);
    expect(studentPasswordSchema.safeParse(pw).success).toBe(false);
  });
});
