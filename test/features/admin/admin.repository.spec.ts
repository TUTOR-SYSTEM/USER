import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/database.module';
import { AdminRepository } from 'src/features/admin/admin.repository';
import { makePrismaMock } from '../../support/prisma-mock';

describe('AdminRepository', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const PARENT = '22222222-2222-4222-8222-222222222222';

  async function build() {
    const db = makePrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [AdminRepository, { provide: PrismaService, useValue: db }],
    }).compile();
    return { repo: moduleRef.get(AdminRepository), db };
  }

  describe('uniqueness lookups', () => {
    it.each([
      ['findByEmail', 'email', 'a@b.c'],
      ['findByUsername', 'username', 'user1'],
      ['findByUserCode', 'userCode', 'C1'],
    ] as const)('%s resolves with the matching id rows', async (method, column, value) => {
      const { repo, db } = await build();
      db.user.findMany.mockResolvedValue([{ id: ID }]);
      await expect((repo[method] as (v: string) => Promise<unknown>)(value)).resolves.toEqual([
        { id: ID },
      ]);
      expect(db.user.findMany).toHaveBeenCalledWith({
        where: { [column]: value },
        select: { id: true },
        take: 1,
      });
    });
  });

  describe('create', () => {
    it('inserts and returns the public projection of the new row', async () => {
      const { repo, db } = await build();
      db.user.create.mockResolvedValue({ id: ID, email: 'a@b.c' });
      await expect(repo.create({ id: ID, email: 'a@b.c' } as never)).resolves.toEqual({
        id: ID,
        email: 'a@b.c',
      });
      const arg = db.user.create.mock.calls[0][0];
      expect(arg.data).toEqual({ id: ID, email: 'a@b.c' });
      expect(arg.select).not.toHaveProperty('password');
    });
  });

  describe('findByIdAndRole / findStudentDetail / existsWithRole', () => {
    it('findByIdAndRole returns the row or null', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce(null);
      await expect(repo.findByIdAndRole(ID, 'TUTOR')).resolves.toEqual({ id: ID });
      await expect(repo.findByIdAndRole(ID, 'TUTOR')).resolves.toBeNull();
      expect(db.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: ID, role: 'TUTOR' } }),
      );
    });

    it('findStudentDetail adds the student-only columns on top of the public ones', async () => {
      const { repo, db } = await build();
      db.user.findFirst
        .mockResolvedValueOnce({ id: ID, parentId: PARENT })
        .mockResolvedValueOnce(null);
      await expect(repo.findStudentDetail(ID)).resolves.toEqual({ id: ID, parentId: PARENT });
      await expect(repo.findStudentDetail(ID)).resolves.toBeNull();
      const arg = db.user.findFirst.mock.calls[0][0];
      expect(arg.where).toEqual({ id: ID, role: 'STUDENT' });
      expect(arg.select).toEqual(
        expect.objectContaining({ parentId: true, tutorId: true, address: true, email: true }),
      );
      expect(arg.select).not.toHaveProperty('password');
    });

    it('existsWithRole is true only when a matching row exists', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce(null);
      await expect(repo.existsWithRole(ID, 'PARENT')).resolves.toBe(true);
      await expect(repo.existsWithRole(ID, 'PARENT')).resolves.toBe(false);
    });
  });

  describe('findParentInfo', () => {
    it('returns the parent row or null', async () => {
      const { repo, db } = await build();
      db.user.findUnique
        .mockResolvedValueOnce({ id: PARENT, relationship: 'MOTHER' })
        .mockResolvedValueOnce(null);
      await expect(repo.findParentInfo(PARENT)).resolves.toEqual({
        id: PARENT,
        relationship: 'MOTHER',
      });
      await expect(repo.findParentInfo(PARENT)).resolves.toBeNull();
    });
  });

  describe('updateByIdAndRole / deleteByIdAndRole', () => {
    it('updateByIdAndRole writes scoped to the role and returns the public row', async () => {
      const { repo, db } = await build();
      db.user.updateMany.mockResolvedValue({ count: 1 });
      db.user.findUnique.mockResolvedValue({ id: ID, firstName: 'New' });
      await expect(repo.updateByIdAndRole(ID, 'STUDENT', { firstName: 'New' })).resolves.toEqual({
        id: ID,
        firstName: 'New',
      });
      expect(db.user.updateMany).toHaveBeenCalledWith({
        where: { id: ID, role: 'STUDENT' },
        data: { firstName: 'New', updatedAt: expect.any(Date) },
      });
    });

    it('updateByIdAndRole returns null when the role does not match', async () => {
      const { repo, db } = await build();
      db.user.updateMany.mockResolvedValue({ count: 0 });
      await expect(repo.updateByIdAndRole(ID, 'STUDENT', { firstName: 'X' })).resolves.toBeNull();
      expect(db.user.findUnique).not.toHaveBeenCalled();
    });

    it('deleteByIdAndRole returns the deleted id, or null when nothing matched', async () => {
      const { repo, db } = await build();
      db.user.findFirst.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce(null);
      db.user.deleteMany.mockResolvedValue({ count: 1 });
      await expect(repo.deleteByIdAndRole(ID, 'TUTOR')).resolves.toEqual({ id: ID });
      expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: ID, role: 'TUTOR' } });
      db.user.deleteMany.mockClear();
      await expect(repo.deleteByIdAndRole(ID, 'TUTOR')).resolves.toBeNull();
      expect(db.user.deleteMany).not.toHaveBeenCalled();
    });

    it('countLinkedUsers counts accounts pointing at the id as tutor or parent', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(2);
      await expect(repo.countLinkedUsers(ID)).resolves.toBe(2);
      expect(db.user.count).toHaveBeenCalledWith({
        where: { OR: [{ tutorId: ID }, { parentId: ID }] },
      });
    });
  });

  describe('list', () => {
    it('returns rows with pagination computed from the count', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(25);
      db.user.findMany.mockResolvedValue([{ id: ID }]);
      await expect(repo.list({ role: 'STUDENT', page: 2, limit: 10 })).resolves.toEqual({
        rows: [{ id: ID }],
        pagination: { total: 25, page: 2, limit: 10, totalPages: 3 },
      });
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role: 'STUDENT' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          skip: 10,
        }),
      );
    });

    it('reports zero total and zero pages when nothing matches', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(0);
      db.user.findMany.mockResolvedValue([]);
      await expect(repo.list({ role: 'TUTOR', page: 1, limit: 10 })).resolves.toEqual({
        rows: [],
        pagination: { total: 0, page: 1, limit: 10, totalPages: 0 },
      });
    });

    it('applies the search (case-insensitive OR) and isActive filters', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(1);
      db.user.findMany.mockResolvedValue([{ id: ID }]);
      await repo.list({ role: 'TUTOR', page: 1, limit: 5, search: ' x ', isActive: true });
      const { where } = db.user.findMany.mock.calls[0][0];
      const contains = { contains: 'x', mode: 'insensitive' };
      expect(where).toEqual({
        role: 'TUTOR',
        isActive: true,
        OR: [
          { email: contains },
          { username: contains },
          { firstName: contains },
          { lastName: contains },
          { phone: contains },
        ],
      });
      expect(db.user.count).toHaveBeenCalledWith({ where });
    });

    it('ignores a whitespace-only search and keeps only the role condition', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(0);
      db.user.findMany.mockResolvedValue([]);
      await repo.list({ role: 'STUDENT', page: 1, limit: 10, search: '   ' });
      expect(db.user.findMany.mock.calls[0][0].where).toEqual({ role: 'STUDENT' });
    });

    it('accepts isActive=false as a real filter value', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(0);
      db.user.findMany.mockResolvedValue([]);
      await repo.list({ role: 'STUDENT', page: 1, limit: 10, isActive: false });
      expect(db.user.findMany.mock.calls[0][0].where).toEqual({
        role: 'STUDENT',
        isActive: false,
      });
    });
  });
});
