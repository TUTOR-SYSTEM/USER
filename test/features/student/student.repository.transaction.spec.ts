import { StudentRepository } from 'src/features/student/student.repository';

const parent = { id: 'p1', email: 'p@x.test', password: 'h', username: 'p', firstName: 'P', lastName: 'Q', userCode: 'PPPPPP', phone: null, relationship: null, gender: 'FEMALE' as const, tutorId: null };
const student = { id: 's1', email: 's@x.test', password: 'h', username: 's', firstName: 'S', lastName: 'T', userCode: 'SSSSSS', phone: null, avatar: null, gender: null, dateOfBirth: null, school: null, parentId: 'p1', tutorId: null };

describe('StudentRepository transactions', () => {
  const build = () => {
    const db = {
      user: {
        create: jest.fn((args: unknown) => ({ op: 'create', args })),
        updateMany: jest.fn((args: unknown) => ({ op: 'updateMany', args })),
        findUnique: jest.fn().mockResolvedValue({ id: 's1', parentId: 'p1' }),
      },
      $transaction: jest.fn(async (ops: unknown[]) => ops.map((o, i) => ({ ...(o as object), i }))),
    };
    return { db, repo: new StudentRepository(db as never) };
  };

  it('writes a new parent and its student in one transaction, parent first', async () => {
    const { db, repo } = build();
    await repo.createStudentWithNewParent(parent, student);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const ops = db.$transaction.mock.calls[0][0] as { args: { data: { role: string } } }[];
    expect(ops.map((o) => o.args.data.role)).toEqual(['PARENT', 'STUDENT']);
  });

  it('creates a parent and links an existing student in one transaction', async () => {
    const { db, repo } = build();
    const result = await repo.createParentAndLinkStudent({ studentId: 's1', parent });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 's1', role: 'STUDENT' } }),
    );
    expect(result).toEqual({ id: 's1', parentId: 'p1' });
  });
});
