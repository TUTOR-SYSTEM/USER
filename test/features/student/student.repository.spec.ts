import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/database.module';
import { StudentRepository } from 'src/features/student/student.repository';
import { makePrismaMock } from '../../support/prisma-mock';

describe('StudentRepository', () => {
  const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
  const PARENT_ID = '44444444-4444-4444-8444-444444444444';

  async function build() {
    const db = makePrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [StudentRepository, { provide: PrismaService, useValue: db }],
    }).compile();
    return { repo: moduleRef.get(StudentRepository), db };
  }

  describe('createStudent / createParent', () => {
    it('inserts a row forced to role STUDENT and returns the inserted row', async () => {
      const { repo, db } = await build();
      const row = { id: STUDENT_ID, role: 'STUDENT' };
      db.user.create.mockResolvedValue(row);
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
      expect(db.user.create).toHaveBeenCalledWith({ data: { ...data, role: 'STUDENT' } });
    });

    it('forces role PARENT when creating a parent', async () => {
      const { repo, db } = await build();
      db.user.create.mockResolvedValue({ id: PARENT_ID });
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
      expect(db.user.create.mock.calls[0][0].data.role).toBe('PARENT');
    });
  });

  describe('findById', () => {
    it('returns null when no STUDENT row matches', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue(null);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toBeNull();
      expect(db.user.findFirst).toHaveBeenCalledWith({
        where: { id: STUDENT_ID, role: 'STUDENT' },
      });
    });

    it('returns the row with parent: null and does not query parents when parentId is null', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue({ id: STUDENT_ID, parentId: null });
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toEqual({
        id: STUDENT_ID,
        parentId: null,
        parent: null,
      });
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('loads the linked parent row when parentId is set', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue({ id: STUDENT_ID, parentId: PARENT_ID });
      db.user.findUnique.mockResolvedValue({ id: PARENT_ID, role: 'PARENT' });
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toEqual({
        id: STUDENT_ID,
        parentId: PARENT_ID,
        parent: { id: PARENT_ID, role: 'PARENT' },
      });
      expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: PARENT_ID } });
    });

    it('sets parent to null when the parentId points at a missing row', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue({ id: STUDENT_ID, parentId: PARENT_ID });
      db.user.findUnique.mockResolvedValue(null);
      await expect(repo.findById({ id: STUDENT_ID })).resolves.toMatchObject({ parent: null });
    });
  });

  describe('findParentById / usernameExists', () => {
    it('findParentById only matches PARENT rows', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue({ id: PARENT_ID });
      await expect(repo.findParentById({ id: PARENT_ID })).resolves.toEqual({ id: PARENT_ID });
      expect(db.user.findFirst).toHaveBeenCalledWith({ where: { id: PARENT_ID, role: 'PARENT' } });
    });

    it('usernameExists is true only when a row has that username', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValueOnce({ id: STUDENT_ID }).mockResolvedValueOnce(null);
      await expect(repo.usernameExists('taken')).resolves.toBe(true);
      await expect(repo.usernameExists('free')).resolves.toBe(false);
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { username: 'taken' },
        select: { id: true },
      });
    });
  });

  describe('update / updateParent / delete', () => {
    it('update is scoped to STUDENT rows and returns the fresh row, or null when none matched', async () => {
      const { repo, db } = await build();
      db.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      db.user.findUnique.mockResolvedValue({ id: STUDENT_ID, school: 'X' });
      await expect(repo.update({ id: STUDENT_ID, data: { school: 'X' } })).resolves.toEqual({
        id: STUDENT_ID,
        school: 'X',
      });
      expect(db.user.updateMany.mock.calls[0][0].where).toEqual({
        id: STUDENT_ID,
        role: 'STUDENT',
      });
      await expect(repo.update({ id: STUDENT_ID, data: { school: 'Y' } })).resolves.toBeNull();
    });

    it('updateParent is scoped to PARENT rows and returns null when none matched', async () => {
      const { repo, db } = await build();
      db.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      db.user.findUnique.mockResolvedValue({ id: PARENT_ID });
      await expect(repo.updateParent({ id: PARENT_ID, data: { phone: '1' } })).resolves.toEqual({
        id: PARENT_ID,
      });
      expect(db.user.updateMany.mock.calls[0][0].where).toEqual({ id: PARENT_ID, role: 'PARENT' });
      await expect(repo.updateParent({ id: PARENT_ID, data: { phone: '2' } })).resolves.toBeNull();
    });

    it('update and updateParent refresh updatedAt alongside the given fields', async () => {
      const { repo, db } = await build();
      db.user.updateMany.mockResolvedValue({ count: 1 });
      db.user.findUnique.mockResolvedValue({});
      await repo.update({ id: STUDENT_ID, data: { school: 'X' } });
      await repo.updateParent({ id: PARENT_ID, data: { phone: '1' } });

      const dataOf = (i: number) => db.user.updateMany.mock.calls[i][0].data;
      expect(dataOf(0)).toMatchObject({ school: 'X' });
      expect(dataOf(0).updatedAt).toBeInstanceOf(Date);
      expect(dataOf(1)).toMatchObject({ phone: '1' });
      expect(dataOf(1).updatedAt).toBeInstanceOf(Date);
    });

    it('delete returns true only when a STUDENT row was removed', async () => {
      const { repo, db } = await build();
      db.user.deleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      await expect(repo.delete({ id: STUDENT_ID })).resolves.toBe(true);
      await expect(repo.delete({ id: STUDENT_ID })).resolves.toBe(false);
      expect(db.user.deleteMany).toHaveBeenCalledWith({
        where: { id: STUDENT_ID, role: 'STUDENT' },
      });
    });
  });

  describe('getAllStudents', () => {
    const row = { id: STUDENT_ID, parent: null };

    it('returns students with pagination computed from total and limit', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(23);
      db.user.findMany.mockResolvedValue([row]);
      const result = await repo.getAllStudents({ query: { page: 2, limit: 10 } as never });
      expect(result).toEqual({
        students: [row],
        pagination: { total: 23, page: 2, limit: 10, totalPages: 3 },
      });
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 10, orderBy: { createdAt: 'desc' } }),
      );
    });

    it('reports total 0 with totalPages 0 when nothing matches', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(0);
      db.user.findMany.mockResolvedValue([]);
      const result = await repo.getAllStudents({ query: { page: 1, limit: 10 } as never });
      expect(result.pagination).toEqual({ total: 0, page: 1, limit: 10, totalPages: 0 });
      expect(result.students).toEqual([]);
    });

    it('always scopes to STUDENT and combines the search and filters', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(1);
      db.user.findMany.mockResolvedValue([row]);
      await repo.getAllStudents({
        query: {
          page: 1,
          limit: 5,
          search: 'an',
          tutorId: PARENT_ID,
          gender: 'MALE',
          isActive: false,
        } as never,
      });
      const { where } = db.user.findMany.mock.calls[0][0];
      const contains = { contains: 'an', mode: 'insensitive' };
      expect(where).toEqual({
        AND: [
          { OR: [{ userCode: contains }, { firstName: contains }, { lastName: contains }] },
          { role: 'STUDENT' },
          { tutorId: PARENT_ID },
          { gender: 'MALE' },
          { isActive: false },
        ],
      });
      expect(db.user.count).toHaveBeenCalledWith({ where });
    });

    it('selects the parent contact info but never the password hash', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(0);
      db.user.findMany.mockResolvedValue([]);
      await repo.getAllStudents({ query: { page: 1, limit: 5 } as never });
      const { select } = db.user.findMany.mock.calls[0][0];
      expect(select).not.toHaveProperty('password');
      expect(select.parent.select).toEqual(
        expect.objectContaining({ id: true, relationship: true }),
      );
      expect(select.parent.select).not.toHaveProperty('password');
    });
  });

  describe('getStudentByField', () => {
    it('returns the matching row', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue({ id: STUDENT_ID, userCode: 'STU1' });
      await expect(repo.getStudentByField({ field: 'userCode', value: 'STU1' })).resolves.toEqual({
        id: STUDENT_ID,
        userCode: 'STU1',
      });
      expect(db.user.findFirst).toHaveBeenCalledWith({ where: { userCode: 'STU1' } });
    });

    it('returns undefined when nothing matches', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue(null);
      await expect(
        repo.getStudentByField({ field: 'username', value: 'nobody' }),
      ).resolves.toBeUndefined();
    });

    it('treats a missing value as an empty string instead of passing undefined to the query', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValue(null);
      await repo.getStudentByField({ field: 'firstName', value: undefined as unknown as string });
      expect(db.user.findFirst).toHaveBeenCalledWith({ where: { firstName: '' } });
    });

    it('refuses a field outside the allow-list without querying', async () => {
      const { repo, db } = await build();
      await expect(
        repo.getStudentByField({ field: 'password', value: 'x' }),
      ).resolves.toBeUndefined();
      expect(db.user.findFirst).not.toHaveBeenCalled();
    });
  });
});
