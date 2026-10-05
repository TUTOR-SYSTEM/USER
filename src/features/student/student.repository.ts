import { Inject, Injectable } from '@nestjs/common';
import type { GetStudentsQueryDto } from '@packages/entities/student';
import { buildListWhereClause } from '@packages/helpers';
import { and, count, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from 'src/database/database.module';
import { users } from '@packages/database/schema';

@Injectable()
export class StudentRepository {
  constructor(@Inject(DRIZZLE) private readonly db: ReturnType<typeof drizzle>) {}

  async createStudent(data: {
    id: string;
    email: string;
    password: string;
    username: string;
    firstName: string;
    lastName: string;
    userCode: string | null;
    phone: string | null;
    avatar: string | null;
    gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
    dateOfBirth: Date | null;
    school: string | null;
    parentId: string | null;
    tutorId: string | null;
  }) {
    const [student] = await this.db
      .insert(users)
      .values({ ...data, role: 'STUDENT' })
      .returning();
    return student;
  }

  async createParent(data: {
    id: string;
    email: string;
    password: string;
    username: string;
    firstName: string;
    lastName: string;
    userCode: string | null;
    phone: string | null;
    relationship: string | null;
    gender: 'MALE' | 'FEMALE' | 'OTHER' | null;
    tutorId: string | null;
  }) {
    const [parent] = await this.db
      .insert(users)
      .values({ ...data, role: 'PARENT' })
      .returning();
    return parent;
  }

  async findById({ id }: { id: string }) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.role, 'STUDENT')))
      .limit(1);
    if (!row) return null;

    const [parent] = row.parentId
      ? await this.db.select().from(users).where(eq(users.id, row.parentId))
      : [];

    return { ...row, parent: parent ?? null };
  }

  async update({ id, data }: { id: string; data: Partial<typeof users.$inferInsert> }) {
    const [student] = await this.db
      .update(users)
      .set(data)
      .where(and(eq(users.id, id), eq(users.role, 'STUDENT')))
      .returning();
    return student ?? null;
  }

  async updateParent({ id, data }: { id: string; data: Partial<typeof users.$inferInsert> }) {
    const [parent] = await this.db
      .update(users)
      .set(data)
      .where(and(eq(users.id, id), eq(users.role, 'PARENT')))
      .returning();
    return parent ?? null;
  }

  async delete({ id }: { id: string }) {
    const [student] = await this.db
      .delete(users)
      .where(and(eq(users.id, id), eq(users.role, 'STUDENT')))
      .returning();
    return !!student;
  }

  // todo : get and filter student ...
  async getAllStudents({ query }: { query: GetStudentsQueryDto }) {
    const { page, limit, search, tutorId, gender, isActive } = query;
    const offset = (page - 1) * limit;

    const where = buildListWhereClause({
      search,
      searchableColumns: {
        userCode: { column: users.userCode },
        firstName: { column: users.firstName },
        lastName: { column: users.lastName },
      },
      filters: { role: 'STUDENT', tutorId, gender, isActive },
      filterColumns: {
        role: { column: users.role },
        tutorId: { column: users.tutorId },
        gender: { column: users.gender },
        isActive: { column: users.isActive },
      },
    });

    const [totalRow] = await this.db.select({ total: count() }).from(users).where(where);
    const total = Number(totalRow?.total ?? 0);

    // Left-join the linked PARENT user so the list carries full parent contact info too —
    // `select()` on the bare `users` table (previous behaviour) leaked the password hash and
    // never included parent data at all.
    const parents = alias(users, 'parents');
    const students = await this.db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        userCode: users.userCode,
        phone: users.phone,
        avatar: users.avatar,
        gender: users.gender,
        dateOfBirth: users.dateOfBirth,
        school: users.school,
        address: users.address,
        district: users.district,
        province: users.province,
        role: users.role,
        isActive: users.isActive,
        parentId: users.parentId,
        tutorId: users.tutorId,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        parent: {
          id: parents.id,
          firstName: parents.firstName,
          lastName: parents.lastName,
          email: parents.email,
          phone: parents.phone,
          avatar: parents.avatar,
          relationship: parents.relationship,
          userCode: parents.userCode,
          address: parents.address,
          district: parents.district,
          province: parents.province,
        },
      })
      .from(users)
      .leftJoin(parents, eq(parents.id, users.parentId))
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      students,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // todo: get detail user by data field (userCode, id , username, name,...)
  async getStudentByField({ field, value }: { field: string; value: string }) {
    const fieldMap = {
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      userCode: users.userCode,
      username: users.username,
    } as const;

    const [result] = await this.db
      .select()
      .from(users)
      .where(eq(fieldMap[field], value ?? ''));

    return result;
  }
}
