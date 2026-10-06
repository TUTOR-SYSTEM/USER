import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../database/database.module';
import { grades, users } from '@packages/database/schema';
import type { GetUsersQueryDto, UpdateGradeDto, UserDataFieldDto } from '@packages/entities/user';

@Injectable()
export class UserRepository {
  constructor(
    @Inject(DRIZZLE)
    private readonly db: ReturnType<typeof drizzle>,
  ) {}

  async findByField(field: UserDataFieldDto['field'], value: string) {
    const columnMap = {
      id: users.id,
      email: users.email,
      username: users.username,
      phone: users.phone,
      userCode: users.userCode,
    } as const;

    const column = columnMap[field as keyof typeof columnMap];
    if (!column) return [];

    return this.db.select().from(users).where(eq(column, value));
  }

  async findById(id: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  }

  async findWithPassword(id: string) {
    const [user] = await this.db
      .select({ id: users.id, password: users.password })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return user ?? null;
  }

  async findUserCode(code: string) {
    const [user] = await this.db.select().from(users).where(eq(users.userCode, code)).limit(1);
    return user ?? null;
  }

  buildUserListConditions(query: GetUsersQueryDto): SQL | undefined {
    const { search, role, isActive } = query;
    const conditions: SQL[] = [];

    if (search?.trim()) {
      const pattern = `%${search.trim()}%`;
      const searchCond = or(
        ilike(users.email, pattern),
        ilike(users.username, pattern),
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
      );
      if (searchCond) conditions.push(searchCond);
    }
    if (role !== undefined) conditions.push(eq(users.role, role));
    if (isActive !== undefined) conditions.push(eq(users.isActive, isActive));

    if (conditions.length === 0) return undefined;
    if (conditions.length === 1) return conditions[0];
    return and(...conditions);
  }

  async paginateUsers(whereClause: SQL | undefined, limit: number, offset: number) {
    return this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        isActive: users.isActive,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(whereClause)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async countUsers(whereClause: SQL | undefined) {
    const [row] = await this.db.select({ total: count() }).from(users).where(whereClause);
    return Number(row?.total ?? 0);
  }

  async create(data: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
    password: string;
    role: 'ADMIN' | 'TUTOR' | 'PARENT' | 'STUDENT';
    userCode?: string;
  }) {
    const [user] = await this.db.insert(users).values(data).returning();
    return user;
  }

  async update(id: string, data: Partial<typeof users.$inferInsert>) {
    const [user] = await this.db
      .update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user ?? null;
  }

  async updatePassword(id: string, hashedPassword: string) {
    const [user] = await this.db
      .update(users)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return user ?? null;
  }

  async delete(id: string) {
    await this.db.delete(users).where(eq(users.id, id));
  }

  async findGradesByUser(userId: string) {
    const [user] = await this.db
      .select({ gradesId: users.gradesId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.gradesId?.length) return [];

    return this.db
      .select()
      .from(grades)
      .where(inArray(grades.id, user.gradesId))
      .orderBy(asc(grades.level));
  }

  async findGradeById(id: string) {
    const [grade] = await this.db.select().from(grades).where(eq(grades.id, id)).limit(1);
    return grade ?? null;
  }

  async updateGrade(id: string, data: UpdateGradeDto) {
    const [grade] = await this.db
      .update(grades)
      .set({ name: data.name, level: data.level })
      .where(eq(grades.id, id))
      .returning();
    return grade ?? null;
  }

  async validateGradeIds(ids: string[]) {
    return this.db.select({ id: grades.id }).from(grades).where(inArray(grades.id, ids));
  }
}
