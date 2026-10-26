import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { Prisma } from '../../generated/prisma/client';
import type { JwtUserRole } from '@packages/helpers';

/** A managed account handled by the admin module. */
export type ManagedRole = Extract<JwtUserRole, 'TUTOR' | 'STUDENT'>;

/** Columns returned to the admin — never leaks the password hash. */
const publicColumns = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  avatar: true,
  phone: true,
  isActive: true,
  role: true,
  description: true,
  userCode: true,
  gender: true,
  dateOfBirth: true,
  school: true,
  subjects: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type ListParams = {
  role: ManagedRole;
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
};

@Injectable()
export class AdminRepository {
  constructor(private readonly db: PrismaService) {}

  findByEmail(email: string) {
    return this.db.user.findMany({ where: { email }, select: { id: true }, take: 1 });
  }

  findByUsername(username: string) {
    return this.db.user.findMany({ where: { username }, select: { id: true }, take: 1 });
  }

  findByUserCode(userCode: string) {
    return this.db.user.findMany({ where: { userCode }, select: { id: true }, take: 1 });
  }

  async create(values: Prisma.UserUncheckedCreateInput) {
    return this.db.user.create({ data: values, select: publicColumns });
  }

  async findByIdAndRole(id: string, role: ManagedRole) {
    return this.db.user.findFirst({ where: { id, role }, select: publicColumns });
  }

  /**
   * Student detail also carries the columns not in the shared `publicColumns`
   * projection (address/district/province/parentId/tutorId) so the service can
   * both enrich it with the parent's info and expose the full student profile.
   */
  async findStudentDetail(id: string) {
    return this.db.user.findFirst({
      where: { id, role: 'STUDENT' },
      select: {
        ...publicColumns,
        address: true,
        district: true,
        province: true,
        parentId: true,
        tutorId: true,
      },
    });
  }

  /** Existence check for optional cross-entity FKs (e.g. `parentId`, `tutorId`) before a write. */
  async existsWithRole(id: string, role: JwtUserRole) {
    const row = await this.db.user.findFirst({ where: { id, role }, select: { id: true } });
    return !!row;
  }

  async findParentInfo(parentId: string) {
    return this.db.user.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        relationship: true,
        userCode: true,
        avatar: true,
      },
    });
  }

  async updateByIdAndRole(
    id: string,
    role: ManagedRole,
    data: Prisma.UserUncheckedUpdateManyInput,
  ) {
    // `update` needs a unique where; the role scope goes through `updateMany`.
    const { count } = await this.db.user.updateMany({
      where: { id, role },
      data: { ...data, updatedAt: new Date() },
    });
    if (count === 0) return null;
    return this.db.user.findUnique({ where: { id }, select: publicColumns });
  }

  /** Accounts pointing at `id` as tutor or parent (they would be cascade-deleted with it). */
  async countLinkedUsers(id: string): Promise<number> {
    return this.db.user.count({ where: { OR: [{ tutorId: id }, { parentId: id }] } });
  }

  async deleteByIdAndRole(id: string, role: ManagedRole) {
    const row = await this.db.user.findFirst({ where: { id, role }, select: { id: true } });
    if (!row) return null;
    await this.db.user.deleteMany({ where: { id, role } });
    return row;
  }

  async list({ role, page, limit, search, isActive }: ListParams) {
    const where: Prisma.UserWhereInput = { role };

    if (search?.trim()) {
      const contains = { contains: search.trim(), mode: 'insensitive' } as const;
      where.OR = [
        { email: contains },
        { username: contains },
        { firstName: contains },
        { lastName: contains },
        { phone: contains },
      ];
    }
    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    const [total, rows] = await Promise.all([
      this.db.user.count({ where }),
      this.db.user.findMany({
        where,
        select: publicColumns,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: (page - 1) * limit,
      }),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return { rows, pagination: { total, page, limit, totalPages } };
  }
}
