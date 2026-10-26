import { Injectable } from '@nestjs/common';
import type { GetStudentsQueryDto } from '@packages/entities/student';
import { buildListWhereClause } from '@packages/helpers';
import { PrismaService } from 'src/database/database.module';
import type { Prisma } from 'src/generated/prisma/client';

/** Parent contact columns embedded in each student row of the list. */
const parentSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  avatar: true,
  relationship: true,
  userCode: true,
  address: true,
  district: true,
  province: true,
} satisfies Prisma.UserSelect;

/** Student list columns — never includes the password hash. */
const studentListSelect = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  userCode: true,
  phone: true,
  avatar: true,
  gender: true,
  dateOfBirth: true,
  school: true,
  address: true,
  district: true,
  province: true,
  role: true,
  isActive: true,
  parentId: true,
  tutorId: true,
  createdAt: true,
  updatedAt: true,
  parent: { select: parentSelect },
} satisfies Prisma.UserSelect;

@Injectable()
export class StudentRepository {
  constructor(private readonly db: PrismaService) {}

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
    return this.db.user.create({ data: { ...data, role: 'STUDENT' } });
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
    return this.db.user.create({ data: { ...data, role: 'PARENT' } });
  }

  async findById({ id }: { id: string }) {
    const row = await this.db.user.findFirst({ where: { id, role: 'STUDENT' } });
    if (!row) return null;

    const parent = row.parentId
      ? await this.db.user.findUnique({ where: { id: row.parentId } })
      : null;

    return { ...row, parent };
  }

  async update({ id, data }: { id: string; data: Prisma.UserUncheckedUpdateManyInput }) {
    return this.updateWithRole(id, 'STUDENT', data);
  }

  /** Existing PARENT user to link to a student; null when no PARENT has that id. */
  async findParentById({ id }: { id: string }) {
    return this.db.user.findFirst({ where: { id, role: 'PARENT' } });
  }

  async updateParent({ id, data }: { id: string; data: Prisma.UserUncheckedUpdateManyInput }) {
    return this.updateWithRole(id, 'PARENT', data);
  }

  async usernameExists(username: string) {
    const row = await this.db.user.findUnique({ where: { username }, select: { id: true } });
    return !!row;
  }

  async delete({ id }: { id: string }) {
    const { count } = await this.db.user.deleteMany({ where: { id, role: 'STUDENT' } });
    return count > 0;
  }

  // todo : get and filter student ...
  async getAllStudents({ query }: { query: GetStudentsQueryDto }) {
    const { page, limit, search, tutorId, gender, isActive } = query;
    const offset = (page - 1) * limit;

    const where = buildListWhereClause<Prisma.UserWhereInput>({
      search,
      searchableColumns: {
        userCode: { column: 'userCode' },
        firstName: { column: 'firstName' },
        lastName: { column: 'lastName' },
      },
      filters: { role: 'STUDENT', tutorId, gender, isActive },
      filterColumns: {
        role: { column: 'role' },
        tutorId: { column: 'tutorId' },
        gender: { column: 'gender' },
        isActive: { column: 'isActive' },
      },
    });

    // The linked PARENT is selected alongside each student so the list carries full parent
    // contact info; the explicit select keeps the password hash out of the rows.
    const [total, students] = await Promise.all([
      this.db.user.count({ where }),
      this.db.user.findMany({
        where,
        select: studentListSelect,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      students,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // todo: get detail user by data field (userCode, id , username, name,...)
  async getStudentByField({ field, value }: { field: string; value: string }) {
    const allowed = ['id', 'firstName', 'lastName', 'userCode', 'username'];
    if (!allowed.includes(field)) return undefined;

    const row = await this.db.user.findFirst({ where: { [field]: value ?? '' } });
    return row ?? undefined;
  }

  /** Prisma `update` needs a unique where, so a role-scoped write goes through `updateMany`. */
  private async updateWithRole(
    id: string,
    role: 'STUDENT' | 'PARENT',
    data: Prisma.UserUncheckedUpdateManyInput,
  ) {
    const { count } = await this.db.user.updateMany({
      where: { id, role },
      data: { ...data, updatedAt: new Date() },
    });
    if (count === 0) return null;
    return this.db.user.findUnique({ where: { id } });
  }
}
