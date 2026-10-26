import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/database.module';
import type { Prisma } from '../../generated/prisma/client';
import type { GetUsersQueryDto, UpdateGradeDto, UserDataFieldDto } from '@packages/entities/user';

const userListSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  avatar: true,
  role: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UserRepository {
  constructor(private readonly db: PrismaService) {}

  async findByField(field: UserDataFieldDto['field'], value: string) {
    const allowed = ['id', 'email', 'username', 'phone', 'userCode'];
    if (!allowed.includes(field)) return [];

    return this.db.user.findMany({ where: { [field]: value } });
  }

  async findById(id: string) {
    return this.db.user.findUnique({ where: { id } });
  }

  async findWithPassword(id: string) {
    return this.db.user.findUnique({ where: { id }, select: { id: true, password: true } });
  }

  async findUserCode(code: string) {
    return this.db.user.findFirst({ where: { userCode: code } });
  }

  buildUserListConditions(query: GetUsersQueryDto): Prisma.UserWhereInput | undefined {
    const { search, role, isActive } = query;
    const conditions: Prisma.UserWhereInput[] = [];

    if (search?.trim()) {
      const term = search.trim();
      const contains = { contains: term, mode: 'insensitive' } as const;
      conditions.push({
        OR: [
          { email: contains },
          { username: contains },
          { firstName: contains },
          { lastName: contains },
          { phone: contains },
        ],
      });
    }
    if (role !== undefined) conditions.push({ role });
    if (isActive !== undefined) conditions.push({ isActive });

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return { AND: conditions };
  }

  async paginateUsers(
    whereClause: Prisma.UserWhereInput | undefined,
    limit: number,
    offset: number,
  ) {
    return this.db.user.findMany({
      where: whereClause,
      select: userListSelect,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  async countUsers(whereClause: Prisma.UserWhereInput | undefined) {
    return this.db.user.count({ where: whereClause });
  }

  async create(data: Prisma.UserUncheckedCreateInput) {
    return this.db.user.create({ data });
  }

  async update(id: string, data: Prisma.UserUncheckedUpdateInput) {
    return this.updateOrNull(id, { ...data, updatedAt: new Date() });
  }

  async updatePassword(id: string, hashedPassword: string) {
    return this.updateOrNull(id, { password: hashedPassword, updatedAt: new Date() });
  }

  async delete(id: string) {
    await this.db.user.deleteMany({ where: { id } });
  }

  async countActiveAdmins(): Promise<number> {
    return this.db.user.count({ where: { role: 'ADMIN', isActive: true } });
  }

  /** Accounts that point at `id` as their tutor or parent — deleting `id` would cascade to them. */
  async countLinkedUsers(id: string): Promise<number> {
    return this.db.user.count({ where: { OR: [{ tutorId: id }, { parentId: id }] } });
  }

  async findGradesByUser(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { gradesId: true },
    });

    if (!user || !user.gradesId?.length) return [];

    return this.db.grade.findMany({
      where: { id: { in: user.gradesId } },
      orderBy: { level: 'asc' },
    });
  }

  async findGradeById(id: string) {
    return this.db.grade.findUnique({ where: { id } });
  }

  async updateGrade(id: string, data: UpdateGradeDto) {
    const { count } = await this.db.grade.updateMany({
      where: { id },
      data: { name: data.name, level: data.level, updatedAt: new Date() },
    });
    return count === 0 ? null : this.db.grade.findUnique({ where: { id } });
  }

  async validateGradeIds(ids: string[]) {
    return this.db.grade.findMany({ where: { id: { in: ids } }, select: { id: true } });
  }

  /** Prisma `update` throws on a missing row; the callers expect `null` instead. */
  private async updateOrNull(id: string, data: Prisma.UserUncheckedUpdateInput) {
    try {
      return await this.db.user.update({ where: { id }, data });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2025') return null;
      throw error;
    }
  }
}
