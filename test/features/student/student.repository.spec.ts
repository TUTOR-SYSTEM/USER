import { Test } from '@nestjs/testing';
import { DRIZZLE } from 'src/database/database.module';
import { StudentRepository } from 'src/features/student/student.repository';

const CHAIN_METHODS = [
  'select',
  'from',
  'where',
  'limit',
  'offset',
  'orderBy',
  'leftJoin',
  'insert',
  'values',
  'update',
  'set',
  'delete',
  'returning',
] as const;

/**
 * Thenable drizzle-like builder: every builder method returns the same chain, and awaiting it
 * resolves to the next queued result. Lets each query in the repository consume one result.
 */
function makeDb(results: unknown[]) {
  const queue = [...results];
  const next = () => {
    const c: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) c[m] = jest.fn(() => c);
    c.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift()).then(resolve, reject);
    return c;
  };
  const calls: Record<string, jest.Mock> = {};
  const wrap = (name: string) => {
    calls[name] = jest.fn(() => next());
    return calls[name];
  };
  const db = {
    select: wrap('select'),
    insert: wrap('insert'),
    update: wrap('update'),
    delete: wrap('delete'),
  };
  return { db, calls, remaining: () => queue.length };
}

describe('StudentRepository', () => {
  const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
  const PARENT_ID = '44444444-4444-4444-8444-444444444444';

  async function build(results: unknown[]) {
    const fake = makeDb(results);
    const moduleRef = await Test.createTestingModule({
      providers: [StudentRepository, { provide: DRIZZLE, useValue: fake.db }],
    }).compile();
    return { repo: moduleRef.get(StudentRepository), ...fake };
  }

  describe('createStudent / createParent', () => {
    it('inserts a row forced to role STUDENT and returns the inserted row', async () => {
      const row = { id: STUDENT_ID, role: 'STUDENT' };
      const { repo, calls } = await build([[row]]);
      const data = {
        id: STUDENT_ID,
        email: 's@x.io',
        password: 'h',
        username: 'u',
        firstName: 'A',
        lastName: 'B',
        userCode: 'C1',
        phone: null,
        avatar: null,
        gender: null,
        dateOfBirth: null,
        school: null,
        parentId: null,
        tutorId: null,
      };
      await expect(repo.createStudent(data)).resolves.toBe(row);
      expect(calls.insert).toHaveBeenCalledTimes(1);
    });

    it('forces role PARENT when creating a parent', async () => {
      const { repo, db } = await build([[{ id: PARENT_ID }]]);
      const values = jest.fn((v: Record<string, unknown>) => {
        expect(v.role).toBe('PARENT');
        return { returning: () => Promise.resolve([{ id: PARENT_ID }]) };
      });
      db.insert.mockReturnValueOnce({ values } as never);
      await expect(
        repo.createParent({
          id: PARENT_ID,
          email: '',
          password: 'h',
          username: 'p',
          firstName: 'P',
          lastName: 'Q',
          userCode: null,
          phone: null,
          relationship: 'MOTHER',
          gender: 'FEMALE',
          tutorId: null,
        }),
      ).resolves.toEqual({ id: PARENT_ID });
      expect(values).toHaveBeenCalledTimes(1);
    });
  });

  describe('findById', () => {
    it('returns null when no STUDENT row matches', async () => {
      const { repo } = await build([[]]);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toBeNull();
    });

    it('returns the row with parent: null and does not query parents when parentId is null', async () => {
      const { repo, calls } = await build([[{ id: STUDENT_ID, parentId: null }]]);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toEqual({
        id: STUDENT_ID,
        parentId: null,
        parent: null,
      });
      expect(calls.select).toHaveBeenCalledTimes(1);
    });

    it('loads the linked parent row when parentId is set', async () => {
      const { repo, calls } = await build([
        [{ id: STUDENT_ID, parentId: PARENT_ID }],
        [{ id: PARENT_ID, role: 'PARENT' }],
      ]);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toEqual({
        id: STUDENT_ID,
        parentId: PARENT_ID,
        parent: { id: PARENT_ID, role: 'PARENT' },
      });
      expect(calls.select).toHaveBeenCalledTimes(2);
    });

    it('sets parent to null when the parentId points at a missing row', async () => {
      const { repo } = await build([[{ id: STUDENT_ID, parentId: PARENT_ID }], []]);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toMatchObject({ parent: null });
    });
  });

  describe('update / updateParent / delete', () => {
    it('update returns the updated STUDENT row, or null when none matched', async () => {
      const { repo } = await build([[{ id: STUDENT_ID, school: 'X' }], []]);
      await expect(repo.update({ id: STUDENT_ID, data: { school: 'X' } })).resolves.toEqual({
        id: STUDENT_ID,
        school: 'X',
      });
      await expect(repo.update({ id: STUDENT_ID, data: { school: 'Y' } })).resolves.toBeNull();
    });

    it('updateParent returns the updated PARENT row, or null when none matched', async () => {
      const { repo } = await build([[{ id: PARENT_ID }], []]);
      await expect(repo.updateParent({ id: PARENT_ID, data: { phone: '1' } })).resolves.toEqual({
        id: PARENT_ID,
      });
      await expect(repo.updateParent({ id: PARENT_ID, data: { phone: '2' } })).resolves.toBeNull();
    });

    it('delete returns true only when a STUDENT row was removed', async () => {
      const { repo } = await build([[{ id: STUDENT_ID }], []]);
      await expect(repo.delete({ id: STUDENT_ID })).resolves.toBe(true);
      await expect(repo.delete({ id: STUDENT_ID })).resolves.toBe(false);
    });
  });

  describe('getAllStudents', () => {
    const row = { id: STUDENT_ID, parent: null };

    it('returns students with pagination computed from total and limit', async () => {
      const { repo } = await build([[{ total: '23' }], [row]]);
      const result = await repo.getAllStudents({
        query: { page: 2, limit: 10 } as never,
      });
      expect(result).toEqual({
        students: [row],
        pagination: { total: 23, page: 2, limit: 10, totalPages: 3 },
      });
    });

    it('treats a missing count row as total 0 with totalPages 0', async () => {
      const { repo } = await build([[], []]);
      const result = await repo.getAllStudents({
        query: { page: 1, limit: 10 } as never,
      });
      expect(result.pagination).toEqual({ total: 0, page: 1, limit: 10, totalPages: 0 });
      expect(result.students).toEqual([]);
    });

    it('runs the count and the page query (two selects)', async () => {
      const { repo, calls } = await build([[{ total: 1 }], [row]]);
      await repo.getAllStudents({ query: { page: 1, limit: 5 } as never });
      expect(calls.select).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStudentByField', () => {
    it('returns the matching row', async () => {
      const { repo, calls } = await build([[{ id: STUDENT_ID, userCode: 'STU1' }]]);
      await expect(repo.getStudentByField({ field: 'userCode', value: 'STU1' })).resolves.toEqual({
        id: STUDENT_ID,
        userCode: 'STU1',
      });
      expect(calls.select).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when nothing matches', async () => {
      const { repo } = await build([[]]);
      await expect(
        repo.getStudentByField({ field: 'username', value: 'nobody' }),
      ).resolves.toBeUndefined();
    });

    it('treats a missing value as an empty string instead of passing undefined to the query', async () => {
      const { repo, calls } = await build([[]]);
      await expect(
        repo.getStudentByField({ field: 'firstName', value: undefined as unknown as string }),
      ).resolves.toBeUndefined();
      expect(calls.select).toHaveBeenCalledTimes(1);
    });
  });
});
