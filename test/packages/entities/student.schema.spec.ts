import { createStudentSchema, updateStudentSchema } from '@packages/entities/student';

describe('student schemas', () => {
  it('lowercases the student and parent email so login (which lowercases) can find them', () => {
    const parsed = createStudentSchema.parse({
      studentName: 'An',
      email: '  Nam@Gmail.COM ',
      parentEmail: 'Mom@Gmail.com',
    });
    expect(parsed.email).toBe('nam@gmail.com');
    expect(parsed.parentEmail).toBe('mom@gmail.com');
    expect(updateStudentSchema.parse({ parentEmail: 'Dad@Gmail.com' }).parentEmail).toBe(
      'dad@gmail.com',
    );
  });

  it('rejects a userCode longer than the VarChar(6) column', () => {
    expect(createStudentSchema.safeParse({ studentName: 'An', userCode: 'ABCDEF' }).success).toBe(
      true,
    );
    expect(createStudentSchema.safeParse({ studentName: 'An', userCode: 'ABCDEFG' }).success).toBe(
      false,
    );
  });
});
