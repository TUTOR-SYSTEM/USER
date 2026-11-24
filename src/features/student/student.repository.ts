import { Injectable } from '@nestjs/common';
import type { GetStudentsQueryDto } from '@packages/entities/student';
import { buildListWhereClause } from '@packages/helpers';
import { PrismaService } from '../../database/database.module';
import { Prisma } from 'src/generated/prisma/client';

/** Lớp mà một học sinh đã tham gia (một dòng / cặp học sinh–lớp). */
export type StudentClassRow = { studentId: string; id: string; name: string; code: string };

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

/** Gia sư quản lý học sinh: chỉ các cột hiển thị, không có password. */
const tutorSummarySelect = {
  id: true,
  firstName: true,
  lastName: true,
  userCode: true,
  email: true,
  phone: true,
  avatar: true,
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
  tutor: { select: tutorSummarySelect },
} satisfies Prisma.UserSelect;

export type NewStudentInput = {
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
  mustChangePassword: boolean;
};

export type NewParentInput = {
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
  mustChangePassword: boolean;
  address?: string | null;
  district?: string | null;
  province?: string | null;
};

@Injectable()
export class StudentRepository {
  constructor(private readonly db: PrismaService) {}

  /**
   * Quy tắc: gia sư quản lý học sinh = gia sư của lớp học sinh đang tham gia.
   * true nếu học sinh đang thuộc một lớp có gia sư khác `tutorId` (null = chưa có gia sư).
   */
  async hasEnrollmentWithOtherTutor({
    studentId,
    tutorId,
  }: {
    studentId: string;
    tutorId: string | null;
  }) {
    const rows = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n
      FROM class_students cs
      JOIN classes c ON c.id = cs.class_id
      WHERE cs.student_id = ${studentId}::uuid
        AND c.tutor_id IS DISTINCT FROM ${tutorId}::uuid`;
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async createStudent(data: NewStudentInput) {
    return this.db.user.create({ data: { ...data, role: 'STUDENT' } });
  }

  async createParent(data: NewParentInput) {
    return this.db.user.create({ data: { ...data, role: 'PARENT' } });
  }

  /**
   * Creates a PARENT and the STUDENT linked to it in one transaction, so a failing student insert
   * (duplicate code/email) never leaves an orphan parent behind. `student.parentId` must be `parent.id`.
   */
  async createStudentWithNewParent(parent: NewParentInput, student: NewStudentInput) {
    const [, createdStudent] = await this.db.$transaction([
      this.db.user.create({ data: { ...parent, role: 'PARENT' } }),
      this.db.user.create({ data: { ...student, role: 'STUDENT' } }),
    ]);
    return createdStudent;
  }

  /** Creates a PARENT and links an existing student to it in one transaction. */
  async createParentAndLinkStudent({
    studentId,
    parent,
  }: {
    studentId: string;
    parent: NewParentInput;
  }) {
    await this.db.$transaction([
      this.db.user.create({ data: { ...parent, role: 'PARENT' } }),
      this.db.user.updateMany({
        where: { id: studentId, role: 'STUDENT' },
        data: { parentId: parent.id, updatedAt: new Date() },
      }),
    ]);
    return this.db.user.findUnique({ where: { id: studentId } });
  }

  /** Học sinh có `parentId` = phụ huynh (role STUDENT). */
  async findChildrenByParentId({ parentId }: { parentId: string }) {
    return this.db.user.findMany({
      where: { parentId, role: 'STUDENT' },
      select: { id: true, firstName: true, lastName: true, userCode: true, tutorId: true },
      orderBy: { firstName: 'asc' },
    });
  }

  async findById({ id }: { id: string }) {
    const row = await this.db.user.findFirst({ where: { id, role: 'STUDENT' } });
    if (!row) return null;

    const parent = row.parentId
      ? await this.db.user.findUnique({ where: { id: row.parentId } })
      : null;
    const tutor = row.tutorId
      ? await this.db.user.findUnique({ where: { id: row.tutorId }, select: tutorSummarySelect })
      : null;

    return { ...row, parent, tutor };
  }

  async update({ id, data }: { id: string; data: Prisma.UserUncheckedUpdateManyInput }) {
    return this.updateWithRole(id, 'STUDENT', data);
  }

  /** Existing PARENT user to link to a student; null when no PARENT has that id. */
  async findParentById({ id }: { id: string }) {
    return this.db.user.findFirst({ where: { id, role: 'PARENT' } });
  }

  /**
   * PARENT the caller may attach to a student. `ownerTutorId` (TUTOR) limits it to parents the tutor
   * created or whose children the tutor manages — the same rule as the picker (`getParents`).
   * Omit it (ADMIN) for any PARENT.
   */
  async findParentForActor({ id, ownerTutorId }: { id: string; ownerTutorId?: string }) {
    return this.db.user.findFirst({
      where: {
        id,
        role: 'PARENT',
        ...(ownerTutorId
          ? { OR: [{ tutorId: ownerTutorId }, { children: { some: { tutorId: ownerTutorId } } }] }
          : {}),
      },
    });
  }

  /** Any account holding `email` — used to reuse a PARENT instead of failing on the UNIQUE index. */
  async findUserByEmail({ email }: { email: string }) {
    return this.db.user.findFirst({
      where: { email },
      select: { id: true, role: true, tutorId: true },
    });
  }

  /**
   * PARENT accounts for the picker. `ownerTutorId` limits them to parents the tutor created or whose
   * children the tutor manages; omit it (ADMIN) for all of them.
   */
  async getParents({
    page,
    limit,
    search,
    ownerTutorId,
  }: {
    page: number;
    limit: number;
    search?: string;
    ownerTutorId?: string;
  }) {
    const conditions: Prisma.UserWhereInput[] = [{ role: 'PARENT' }];
    const searchWhere = buildListWhereClause<Prisma.UserWhereInput>({
      search,
      searchableColumns: {
        firstName: { column: 'firstName' },
        lastName: { column: 'lastName' },
        email: { column: 'email' },
        phone: { column: 'phone' },
        userCode: { column: 'userCode' },
      },
    });
    if (searchWhere) conditions.push(searchWhere);
    if (ownerTutorId) {
      conditions.push({
        OR: [{ tutorId: ownerTutorId }, { children: { some: { tutorId: ownerTutorId } } }],
      });
    }
    const where: Prisma.UserWhereInput = { AND: conditions };

    const [total, parents] = await Promise.all([
      this.db.user.count({ where }),
      this.db.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          avatar: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: [{ firstName: 'asc' }, { id: 'asc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
    ]);
    return { parents, total };
  }

  async findTutorById({ id }: { id: string }) {
    return this.db.user.findFirst({ where: { id, role: 'TUTOR' } });
  }

  /**
   * Lớp học sinh đã tham gia. `class_students` / `classes` do tutor-service ghi trên cùng DB,
   * không có model Prisma ở repo này nên đọc bằng raw SQL.
   */
  async findClassesByStudentIds({
    studentIds,
  }: {
    studentIds: string[];
  }): Promise<StudentClassRow[]> {
    if (studentIds.length === 0) return [];
    return this.db.$queryRaw<StudentClassRow[]>`
      SELECT cs.student_id AS "studentId", c.id, c.name, c.code
      FROM class_students cs
      JOIN classes c ON c.id = cs.class_id
      WHERE cs.student_id IN (${Prisma.join(studentIds)})
      ORDER BY c.name ASC`;
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
