import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../database/database.module';
import { users } from '@tutor/gateway/schema';
import type { JwtUserRole } from '@packages/helpers';

/** A managed account handled by the admin module. */
export type ManagedRole = Extract<JwtUserRole, 'TUTOR' | 'STUDENT'>;

/** Columns returned to the admin — never leaks the password hash. */
const publicColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  firstName: users.firstName,
  lastName: users.lastName,
  avatar: users.avatar,
  phone: users.phone,
  isActive: users.isActive,
  role: users.role,
  description: users.description,
  userCode: users.userCode,
  gender: users.gender,
  dateOfBirth: users.dateOfBirth,
  school: users.school,
  subjects: users.subjects,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

type ListParams = {
  role: ManagedRole;
  page: number;
  limit: number;
  search?: string;
  isActive?: boolean;
};

@Injectable()
export class AdminRepository {
  constructor(@Inject(DRIZZLE) private readonly db: ReturnType<typeof drizzle>) {}

  findByEmail(email: string) {
    return this.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  }

  findByUsername(username: string) {
    return this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
  }

  findByUserCode(userCode: string) {
    return this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.userCode, userCode))
      .limit(1);
  }

  async create(values: typeof users.$inferInsert) {
    const [row] = await this.db.insert(users).values(values).returning(publicColumns);
    return row;
  }

  async findByIdAndRole(id: string, role: ManagedRole) {
    const [row] = await this.db
      .select(publicColumns)
      .from(users)
      .where(and(eq(users.id, id), eq(users.role, role)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Student detail also carries the columns not in the shared `publicColumns`
   * projection (address/district/province/parentId/tutorId) so the service can
   * both enrich it with the parent's info and expose the full student profile.
   */
  async findStudentDetail(id: string) {
    const [row] = await this.db
      .select({
        ...publicColumns,
        address: users.address,
        district: users.district,
        province: users.province,
        parentId: users.parentId,
        tutorId: users.tutorId,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.role, 'STUDENT')))
      .limit(1);
    return row ?? null;
  }

  /** Existence check for optional cross-entity FKs (e.g. `parentId`, `tutorId`) before a write. */
  async existsWithRole(id: string, role: JwtUserRole) {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), eq(users.role, role)))
      .limit(1);
    return !!row;
  }

  async findParentInfo(parentId: string) {
    const [row] = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        phone: users.phone,
        relationship: users.relationship,
        userCode: users.userCode,
        avatar: users.avatar,
      })
      .from(users)
      .where(eq(users.id, parentId))
      .limit(1);
    return row ?? null;
  }

  async updateByIdAndRole(id: string, role: ManagedRole, data: Partial<typeof users.$inferInsert>) {
    const [row] = await this.db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.role, role)))
      .returning(publicColumns);
    return row ?? null;
  }

  async deleteByIdAndRole(id: string, role: ManagedRole) {
    const [row] = await this.db
      .delete(users)
      .where(and(eq(users.id, id), eq(users.role, role)))
      .returning({ id: users.id });
    return row ?? null;
  }

  async list({ role, page, limit, search, isActive }: ListParams) {
    const conditions: SQL[] = [eq(users.role, role)];

    if (search?.trim()) {
      const pattern = `%${search.trim()}%`;
      const searchCond = or(
        ilike(users.email, pattern),
        ilike(users.username, pattern),
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
        ilike(users.phone, pattern),
      );
      if (searchCond) conditions.push(searchCond);
    }
    if (isActive !== undefined) {
      conditions.push(eq(users.isActive, isActive));
    }

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
    const offset = (page - 1) * limit;

    const [[totalRow], rows] = await Promise.all([
      this.db.select({ total: count() }).from(users).where(whereClause),
      this.db
        .select(publicColumns)
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
    ]);

    const total = Number(totalRow?.total ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return { rows, pagination: { total, page, limit, totalPages } };
  }
}
