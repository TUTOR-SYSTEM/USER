import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DRIZZLE } from '../../database/database.module';
import { users } from '@packages/database/schema';
import type {
  CreateStudentDto,
  GetStudentsQueryDto,
  UpdateStudentDto,
} from '@packages/entities/student';
import type { JwtGuardUser } from '../../packages/guards/jwt-auth.guard';
import { StudentRepository } from './student.repository';
import { generateCode, hashData } from '@packages/helpers';
import { randomUUID } from 'node:crypto';

@Injectable()
export class StudentService {
  private readonly logger = new Logger(StudentService.name);
  constructor(
    private readonly repo: StudentRepository,
    @Inject(DRIZZLE)
    private readonly db: ReturnType<typeof drizzle>,
  ) {}

  // TODO: generate unique code ...
  private async generateUniqueCode(): Promise<string> {
    const MAX_RETRIES = 5;
    let attempts = 0;
    let newCode = generateCode();

    while (await this.repo.getStudentByField({ field: 'userCode', value: newCode })) {
      attempts++;
      if (attempts >= MAX_RETRIES) {
        throw new ConflictException(ERROR_MESSAGES.UNABLE_TO_GENERATE_UNIQUE_CODE);
      }
      newCode = generateCode();
    }

    return newCode;
  }

  // TODO: generate unique code services ...
  async generateStudentCodeService(): Promise<string> {
    return this.generateUniqueCode();
  }

  private splitName(name: string): { firstName: string; lastName: string } {
    const spaceIdx = name.indexOf(' ');
    return {
      firstName: spaceIdx === -1 ? name : name.slice(0, spaceIdx),
      lastName: spaceIdx === -1 ? '' : name.slice(spaceIdx + 1),
    };
  }

  // TODO: generate username from full name ...
  private async generateUsernameFromName(firstName: string, lastName: string): Promise<string> {
    const base = `${lastName}${firstName}`
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');

    for (let i = 0; i < 10; i++) {
      const candidate = i === 0 ? base : `${base}_${i}`;
      const [existing] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, candidate))
        .limit(1);
      if (!existing) return candidate;
    }

    throw new ConflictException(
      `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: ${firstName} ${lastName}`,
    );
  }

  /**
   * Create a new student, auto-creating a linked PARENT account when parent info is supplied.
   * The creating user (tutor/admin) is recorded as `tutorId` on both records.
   */
  async create(dto: CreateStudentDto, currentUser: JwtGuardUser) {
    // 1. Resolve the student code: if the client supplied one, it must be free — reject the
    // request instead of silently generating a different code. Otherwise, auto-generate one.
    let studentCode: string;
    if (dto.userCode) {
      const taken = await this.repo.getStudentByField({ field: 'userCode', value: dto.userCode });
      if (taken)
        throw new ConflictException(`${ERROR_MESSAGES.STUDENT_CODE_EXISTS}: ${dto.userCode}`);
      studentCode = dto.userCode;
    } else {
      studentCode = await this.generateUniqueCode();
    }

    // 2. Split the student's full name into the first/last name columns `users` expects.
    const { firstName, lastName } = this.splitName(dto.studentName);

    // 3. Generate a unique username + default password for the new student login.
    const studentUsername = await this.generateUsernameFromName(firstName, lastName);
    const hashedStudentPassword = await hashData('Student@123456');

    // 4. If parent info was submitted, create the PARENT user first so it can be linked below.
    let parentId: string | null = null;
    if (dto.parentName) {
      const { firstName: parentFirstName, lastName: parentLastName } = this.splitName(
        dto.parentName,
      );
      const parentUsername = await this.generateUsernameFromName(parentFirstName, parentLastName);
      const parentCode = await this.generateUniqueCode();
      const hashedParentPassword = await hashData('Parent@123456');

      const parent = await this.repo.createParent({
        id: randomUUID(),
        email: dto.parentEmail || '',
        password: hashedParentPassword,
        username: parentUsername,
        firstName: parentFirstName,
        lastName: parentLastName,
        userCode: parentCode,
        phone: dto.parentPhone ?? null,
        relationship: dto.parentRelationship ?? null,
        gender: dto.parentRelationship === 'FATHER' ? 'MALE' : 'FEMALE',
        tutorId: currentUser.id,
      });
      parentId = parent.id;
    }

    // 5. Create the student, linking the parent (if any) and the creating tutor/admin.
    const student = await this.repo.createStudent({
      id: randomUUID(),
      email: dto.email || `${studentUsername}@no-email.local`,
      password: hashedStudentPassword,
      username: studentUsername,
      firstName,
      lastName,
      userCode: studentCode,
      phone: dto.studentPhone ?? null,
      avatar: null,
      gender: dto.gender ?? null,
      dateOfBirth: null,
      school: dto.school ?? null,
      parentId,
      tutorId: currentUser.id,
    });

    return student;
  }

  async findAll(query: GetStudentsQueryDto) {
    const { students, pagination } = await this.repo.getAllStudents({ query });

    return {
      students: students.map((s) => ({
        id: s.id,
        email: s.email,
        username: s.username,
        firstName: s.firstName,
        lastName: s.lastName,
        userCode: s.userCode,
        phone: s.phone,
        avatar: s.avatar,
        gender: s.gender,
        dateOfBirth: s.dateOfBirth instanceof Date ? s.dateOfBirth.toISOString() : s.dateOfBirth,
        school: s.school,
        address: s.address,
        district: s.district,
        province: s.province,
        parentId: s.parentId,
        parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}`.trim() : null,
        parentPhone: s.parent?.phone ?? null,
        parentEmail: s.parent?.email ?? null,
        parentRelationship: s.parent?.relationship ?? null,
        parent: s.parent
          ? {
              id: s.parent.id,
              firstName: s.parent.firstName,
              lastName: s.parent.lastName,
              email: s.parent.email,
              phone: s.parent.phone,
              relationship: s.parent.relationship,
              userCode: s.parent.userCode,
              avatar: s.parent.avatar,
              address: s.parent.address,
              district: s.parent.district,
              province: s.parent.province,
            }
          : null,
        role: s.role,
        isActive: s.isActive,
        createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : String(s.createdAt),
        updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : String(s.updatedAt),
      })),
      pagination,
    };
  }

  async findById(id: string) {
    const user = await this.repo.findById({ id });
    if (!user) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);

    const parent = user.parent;

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      userCode: user.userCode,
      phone: user.phone,
      avatar: user.avatar,
      gender: user.gender,
      dateOfBirth:
        user.dateOfBirth instanceof Date ? user.dateOfBirth.toISOString() : user.dateOfBirth,
      school: user.school,
      address: user.address,
      district: user.district,
      province: user.province,
      parentId: user.parentId,
      parentName: parent ? `${parent.firstName} ${parent.lastName}`.trim() : null,
      parentPhone: parent?.phone ?? null,
      parentEmail: parent?.email ?? null,
      parentRelationship: parent?.relationship ?? null,
      parent: parent
        ? {
            id: parent.id,
            firstName: parent.firstName,
            lastName: parent.lastName,
            email: parent.email,
            phone: parent.phone,
            relationship: parent.relationship,
            userCode: parent.userCode,
            avatar: parent.avatar,
            address: parent.address,
            district: parent.district,
            province: parent.province,
          }
        : null,
      role: user.role,
      isActive: user.isActive,
      createdAt:
        user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt),
      updatedAt:
        user.updatedAt instanceof Date ? user.updatedAt.toISOString() : String(user.updatedAt),
    };
  }

  async update(id: string, dto: UpdateStudentDto) {
    const student = await this.repo.findById({ id });
    if (!student) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);

    // ── student fields ──
    const studentUpdate: Partial<typeof users.$inferInsert> = {};
    if (dto.studentName !== undefined) {
      const { firstName, lastName } = this.splitName(dto.studentName);
      studentUpdate.firstName = firstName;
      studentUpdate.lastName = lastName;
    }
    if (dto.studentPhone !== undefined) studentUpdate.phone = dto.studentPhone || null;
    if (dto.gender !== undefined) studentUpdate.gender = dto.gender;
    if (dto.birthday !== undefined) studentUpdate.dateOfBirth = dto.birthday;
    if (dto.school !== undefined) studentUpdate.school = dto.school || null;
    if (dto.address !== undefined) studentUpdate.address = dto.address || null;
    if (dto.district !== undefined) studentUpdate.district = dto.district || null;
    if (dto.province !== undefined) studentUpdate.province = dto.province || null;
    if (dto.avatar !== undefined) studentUpdate.avatar = dto.avatar;

    let updated: Omit<typeof student, 'parent'> = student;
    if (Object.keys(studentUpdate).length > 0) {
      updated = (await this.repo.update({ id, data: studentUpdate })) ?? student;
    }

    // ── parent fields ──
    const hasParentField =
      dto.parentName !== undefined ||
      dto.parentPhone !== undefined ||
      dto.parentEmail !== undefined ||
      dto.parentRelationship !== undefined ||
      dto.parentAddress !== undefined ||
      dto.parentDistrict !== undefined ||
      dto.parentProvince !== undefined;

    if (hasParentField) {
      if (student.parentId) {
        const parentUpdate: Partial<typeof users.$inferInsert> = {};
        if (dto.parentName !== undefined) {
          const { firstName, lastName } = this.splitName(dto.parentName);
          parentUpdate.firstName = firstName;
          parentUpdate.lastName = lastName;
        }
        if (dto.parentPhone !== undefined) parentUpdate.phone = dto.parentPhone || null;
        if (dto.parentEmail !== undefined) parentUpdate.email = dto.parentEmail;
        if (dto.parentRelationship !== undefined)
          parentUpdate.relationship = dto.parentRelationship;
        if (dto.parentAddress !== undefined) parentUpdate.address = dto.parentAddress || null;
        if (dto.parentDistrict !== undefined) parentUpdate.district = dto.parentDistrict || null;
        if (dto.parentProvince !== undefined) parentUpdate.province = dto.parentProvince || null;
        if (Object.keys(parentUpdate).length > 0) {
          await this.repo.updateParent({ id: student.parentId, data: parentUpdate });
        }
      } else if (dto.parentName) {
        // No parent linked yet — create one (mirrors create flow)
        const parentUserId = randomUUID();
        const parentCode = await this.generateUniqueCode();
        const hashedParentPassword = await hashData('Parent@123456');
        const resolvedParentEmail = dto.parentEmail ?? '';
        const { firstName, lastName } = this.splitName(dto.parentName);
        const parentUsername = await this.generateUsernameFromName(firstName, lastName);
        const parent = await this.repo.createParent({
          id: parentUserId,
          email: resolvedParentEmail,
          password: hashedParentPassword,
          username: parentUsername,
          firstName,
          lastName,
          userCode: parentCode,
          phone: dto.parentPhone ?? null,
          relationship: dto.parentRelationship ?? null,
          gender: dto.parentRelationship === 'FATHER' ? 'MALE' : 'FEMALE',
          tutorId: student.tutorId,
        });
        if (dto.parentAddress || dto.parentDistrict || dto.parentProvince) {
          await this.repo.updateParent({
            id: parent.id,
            data: {
              address: dto.parentAddress || null,
              district: dto.parentDistrict || null,
              province: dto.parentProvince || null,
            },
          });
        }
        // Link the newly created parent to the student — do NOT pass the parent's own
        // record here, `repo.update` writes onto the student's row (`id`).
        updated = (await this.repo.update({ id, data: { parentId: parent.id } })) ?? student;
      }
    }

    return updated;
  }

  async delete(id: string) {
    const student = await this.repo.findById({ id });
    if (!student) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    await this.repo.delete({ id });
    return { id };
  }
}
