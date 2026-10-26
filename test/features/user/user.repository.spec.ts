import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/database/database.module';
import { UserRepository } from 'src/features/user/user.repository';
import { makePrismaMock } from '../../support/prisma-mock';

describe('UserRepository', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  async function build() {
    const db = makePrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [UserRepository, { provide: PrismaService, useValue: db }],
    }).compile();
    return { repo: moduleRef.get(UserRepository), db };
  }

  describe('findByField', () => {
    it.each(['id', 'email', 'username', 'phone', 'userCode'] as const)(
      'queries by the %s column',
      async (field) => {
        const { repo, db } = await build();
        db.user.findMany.mockResolvedValue([{ id: ID }]);
        await expect(repo.findByField(field, 'v')).resolves.toEqual([{ id: ID }]);
        expect(db.user.findMany).toHaveBeenCalledWith({ where: { [field]: 'v' } });
      },
    );

    it('returns an empty list and issues no query for an unmapped field', async () => {
      const { repo, db } = await build();
      await expect(repo.findByField('password' as never, 'x')).resolves.toEqual([]);
      expect(db.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe('single-row lookups', () => {
    it('findById returns the row or null', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValueOnce({ id: ID }).mockResolvedValueOnce(null);
      await expect(repo.findById(ID)).resolves.toEqual({ id: ID });
      await expect(repo.findById(ID)).resolves.toBeNull();
      expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: ID } });
    });

    it('findWithPassword selects only id and password', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValue({ id: ID, password: 'h' });
      await expect(repo.findWithPassword(ID)).resolves.toEqual({ id: ID, password: 'h' });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: ID },
        select: { id: true, password: true },
      });
    });

    it('findUserCode returns the row or null', async () => {
      const { repo, db } = await build();
      db.user.findFirst
        .mockResolvedValueOnce({ id: ID, userCode: 'C1' })
        .mockResolvedValueOnce(null);
      await expect(repo.findUserCode('C1')).resolves.toEqual({ id: ID, userCode: 'C1' });
      await expect(repo.findUserCode('C1')).resolves.toBeNull();
      expect(db.user.findFirst).toHaveBeenCalledWith({ where: { userCode: 'C1' } });
    });
  });

  describe('buildUserListConditions', () => {
    it('returns undefined when no filter is set', async () => {
      const { repo } = await build();
      expect(repo.buildUserListConditions({ page: 1, limit: 10 } as never)).toBeUndefined();
    });

    it('ignores a whitespace-only search', async () => {
      const { repo } = await build();
      expect(repo.buildUserListConditions({ search: '   ' } as never)).toBeUndefined();
    });

    it('returns a single condition unwrapped when only one filter is set', async () => {
      const { repo } = await build();
      expect(repo.buildUserListConditions({ role: 'TUTOR' } as never)).toEqual({ role: 'TUTOR' });
    });

    it('searches case-insensitively across the contact columns', async () => {
      const { repo } = await build();
      const contains = { contains: 'an', mode: 'insensitive' };
      expect(repo.buildUserListConditions({ search: ' an ' } as never)).toEqual({
        OR: [
          { email: contains },
          { username: contains },
          { firstName: contains },
          { lastName: contains },
          { phone: contains },
        ],
      });
    });

    it('combines search, role and isActive with AND when all are set', async () => {
      const { repo } = await build();
      const where = repo.buildUserListConditions({
        search: 'an',
        role: 'STUDENT',
        isActive: false,
      } as never);
      expect(where).toEqual({
        AND: [
          expect.objectContaining({ OR: expect.any(Array) }),
          { role: 'STUDENT' },
          { isActive: false },
        ],
      });
    });

    it('keeps isActive=false (falsy but set)', async () => {
      const { repo } = await build();
      expect(repo.buildUserListConditions({ isActive: false } as never)).toEqual({
        isActive: false,
      });
    });
  });

  describe('pagination and counts', () => {
    it('paginateUsers orders newest first and applies take/skip', async () => {
      const { repo, db } = await build();
      db.user.findMany.mockResolvedValue([{ id: ID }]);
      await expect(repo.paginateUsers({ role: 'ADMIN' }, 10, 20)).resolves.toEqual([{ id: ID }]);
      expect(db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role: 'ADMIN' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          skip: 20,
        }),
      );
      const { select } = db.user.findMany.mock.calls[0][0];
      expect(select).not.toHaveProperty('password');
    });

    it('countUsers passes the where clause through', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(7);
      await expect(repo.countUsers({ role: 'ADMIN' })).resolves.toBe(7);
      expect(db.user.count).toHaveBeenCalledWith({ where: { role: 'ADMIN' } });
    });

    it('countActiveAdmins counts active ADMIN accounts', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(2);
      await expect(repo.countActiveAdmins()).resolves.toBe(2);
      expect(db.user.count).toHaveBeenCalledWith({ where: { role: 'ADMIN', isActive: true } });
    });

    it('countLinkedUsers counts accounts pointing at the id as tutor or parent', async () => {
      const { repo, db } = await build();
      db.user.count.mockResolvedValue(3);
      await expect(repo.countLinkedUsers(ID)).resolves.toBe(3);
      expect(db.user.count).toHaveBeenCalledWith({
        where: { OR: [{ tutorId: ID }, { parentId: ID }] },
      });
    });
  });

  describe('writes', () => {
    it('create inserts and returns the new row', async () => {
      const { repo, db } = await build();
      db.user.create.mockResolvedValue({ id: ID });
      const data = {
        id: ID,
        email: 'a@b.c',
        username: 'u',
        firstName: 'A',
        lastName: 'B',
        password: 'h',
        role: 'TUTOR' as const,
      };
      await expect(repo.create(data)).resolves.toEqual({ id: ID });
      expect(db.user.create).toHaveBeenCalledWith({ data });
    });

    it('update returns the updated row and stamps updatedAt', async () => {
      const { repo, db } = await build();
      db.user.update.mockResolvedValue({ id: ID, firstName: 'New' });
      await expect(repo.update(ID, { firstName: 'New' })).resolves.toEqual({
        id: ID,
        firstName: 'New',
      });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { firstName: 'New', updatedAt: expect.any(Date) },
      });
    });

    it('update returns null when no row matched (P2025)', async () => {
      const { repo, db } = await build();
      db.user.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
      await expect(repo.update(ID, { firstName: 'New' })).resolves.toBeNull();
    });

    it('update rethrows any other database error', async () => {
      const { repo, db } = await build();
      db.user.update.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
      await expect(repo.update(ID, { firstName: 'New' })).rejects.toThrow('dup');
    });

    it('updatePassword writes the hash, or returns null when nothing matched', async () => {
      const { repo, db } = await build();
      db.user.update
        .mockResolvedValueOnce({ id: ID })
        .mockRejectedValueOnce(Object.assign(new Error('nf'), { code: 'P2025' }));
      await expect(repo.updatePassword(ID, 'hash')).resolves.toEqual({ id: ID });
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { password: 'hash', updatedAt: expect.any(Date) },
      });
      await expect(repo.updatePassword(ID, 'hash')).resolves.toBeNull();
    });

    it('delete removes the row and returns nothing', async () => {
      const { repo, db } = await build();
      db.user.deleteMany.mockResolvedValue({ count: 1 });
      await expect(repo.delete(ID)).resolves.toBeUndefined();
      expect(db.user.deleteMany).toHaveBeenCalledWith({ where: { id: ID } });
    });
  });

  describe('grades', () => {
    it('findGradesByUser returns [] when the user does not exist', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValue(null);
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([]);
      expect(db.grade.findMany).not.toHaveBeenCalled();
    });

    it('findGradesByUser returns [] without a grades query when gradesId is empty', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValue({ gradesId: [] });
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([]);
      expect(db.grade.findMany).not.toHaveBeenCalled();
    });

    it('findGradesByUser returns the grades ordered by level when gradesId is set', async () => {
      const { repo, db } = await build();
      db.user.findUnique.mockResolvedValue({ gradesId: ['g1'] });
      db.grade.findMany.mockResolvedValue([{ id: 'g1', level: 1 }]);
      await expect(repo.findGradesByUser(ID)).resolves.toEqual([{ id: 'g1', level: 1 }]);
      expect(db.grade.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['g1'] } },
        orderBy: { level: 'asc' },
      });
    });

    it('findGradeById returns the row or null', async () => {
      const { repo, db } = await build();
      db.grade.findUnique.mockResolvedValueOnce({ id: 'g1' }).mockResolvedValueOnce(null);
      await expect(repo.findGradeById('g1')).resolves.toEqual({ id: 'g1' });
      await expect(repo.findGradeById('g1')).resolves.toBeNull();
    });

    it('updateGrade writes name and level and returns the row', async () => {
      const { repo, db } = await build();
      db.grade.updateMany.mockResolvedValue({ count: 1 });
      db.grade.findUnique.mockResolvedValue({ id: 'g1', name: 'N', level: 2 });
      await expect(repo.updateGrade('g1', { name: 'N', level: 2 } as never)).resolves.toEqual({
        id: 'g1',
        name: 'N',
        level: 2,
      });
      expect(db.grade.updateMany).toHaveBeenCalledWith({
        where: { id: 'g1' },
        data: { name: 'N', level: 2, updatedAt: expect.any(Date) },
      });
    });

    it('updateGrade returns null when the grade does not exist', async () => {
      const { repo, db } = await build();
      db.grade.updateMany.mockResolvedValue({ count: 0 });
      await expect(repo.updateGrade('g1', { name: 'N', level: 2 } as never)).resolves.toBeNull();
      expect(db.grade.findUnique).not.toHaveBeenCalled();
    });

    it('validateGradeIds returns the matching grade rows', async () => {
      const { repo, db } = await build();
      db.grade.findMany.mockResolvedValue([{ id: 'g1' }, { id: 'g2' }]);
      await expect(repo.validateGradeIds(['g1', 'g2', 'gX'])).resolves.toEqual([
        { id: 'g1' },
        { id: 'g2' },
      ]);
      expect(db.grade.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['g1', 'g2', 'gX'] } },
        select: { id: true },
      });
    });
  });
});
