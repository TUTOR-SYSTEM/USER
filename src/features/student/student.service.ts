import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  HttpStatus,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import type { Prisma } from '../../generated/prisma/client';
import type {
  CreateStudentDto,
  GetParentsQueryDto,
  GetStudentsQueryDto,
  UpdateStudentDto,
} from '@packages/entities/student';
import type { UserActor } from '../user/user.service';
import { StudentRepository, type NewParentInput, type NewStudentInput } from './student.repository';
import {
  checkUuidValid,
  generateCode,
  generateRandomPassword,
  sendAccountCreatedMail,
  hashData,
  pickFreeUsername,
  revokeAllUserSessions,
  usernameBase,
} from '@packages/helpers';
import { RmqProducer } from '../rabbitmq/rmq.producer';
import { randomUUID } from 'node:crypto';

/** Response shape never carries the password hash (repository `.returning()` returns full rows). */
function omitPassword<T extends { password?: unknown }>(row: T): Omit<T, 'password'> {
  const safe: Partial<T> = { ...row };
  delete safe.password;
  return safe as Omit<T, 'password'>;
}

/** Gia sư quản lý (tóm tắt, không có password). */
function toTutorSummary(
  tutor: {
    id: string;
    firstName: string;
    lastName: string;
    userCode: string | null;
    email: string;
    phone: string | null;
    avatar: string | null;
  } | null,
) {
  if (!tutor) return null;
  return {
    id: tutor.id,
    firstName: tutor.firstName,
    lastName: tutor.lastName,
    userCode: tutor.userCode,
    email: tutor.email,
    phone: tutor.phone,
    avatar: tutor.avatar,
  };
}

function assertStudentId(id: string): void {
  if (!id || !checkUuidValid({ data: id })) {
    throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);
  }
}

/**
 * Student management is open to ADMIN and TUTOR. A TUTOR only reaches students whose `tutorId` is
 * their own; ADMIN bypasses ownership.
 */
function assertStaff(actor: UserActor): void {
  if (actor.role !== 'ADMIN' && actor.role !== 'TUTOR') {
    throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }
}

function assertCanManage(actor: UserActor, student: { tutorId: string | null }): void {
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'TUTOR' && student.tutorId === actor.id) return;
  throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
}

@Injectable()
export class StudentService {
  private readonly logger = new Logger(StudentService.name);
  constructor(
    private readonly repo: StudentRepository,
    private readonly rmqProducer: RmqProducer,
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

  /**
   * Vietnamese order ("Họ Tên"), same convention as tutors: the first word is the family name
   * (`lastName`), the rest is the given name (`firstName`). A single word stays in `firstName`.
   */
  private splitName(name: string): { firstName: string; lastName: string } {
    const spaceIdx = name.indexOf(' ');
    return {
      firstName: spaceIdx === -1 ? name : name.slice(spaceIdx + 1),
      lastName: spaceIdx === -1 ? '' : name.slice(0, spaceIdx),
    };
  }

  /** `reserved`: usernames already picked in this request but not written yet. */
  private async generateUsernameFromName(
    firstName: string,
    lastName: string,
    reserved: string[] = [],
  ): Promise<string> {
    const username = await pickFreeUsername(
      usernameBase(firstName, lastName, '_'),
      async (candidate) =>
        reserved.includes(candidate) || (await this.repo.usernameExists(candidate)),
      '_',
    );
    if (username) return username;

    throw new ConflictException(
      `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: ${lastName} ${firstName}`,
    );
  }

  /**
   * Create a new student, auto-creating a linked PARENT account when parent info is supplied.
   * The creating user (tutor/admin) is recorded as `tutorId` on both records.
   */
  private async resolveManagingTutor(dto: CreateStudentDto, actor: UserActor): Promise<string> {
    if (actor.role === 'TUTOR') return actor.id;
    const fieldError = (message: string) =>
      new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: ERROR_MESSAGES.VALIDATION_FAILED,
        errors: [{ field: 'tutorId', message, code: 'required' }],
      });
    if (!dto.tutorId) throw fieldError(ERROR_MESSAGES.STUDENT_TUTOR_REQUIRED);
    const tutor = await this.repo.findTutorById({ id: dto.tutorId });
    if (!tutor) throw fieldError(ERROR_MESSAGES.TUTOR_NOT_FOUND);
    return tutor.id;
  }

  async create(dto: CreateStudentDto, actor: UserActor) {
    assertStaff(actor);
    // Tutor tạo thì học sinh thuộc chính tutor đó. Admin phải chọn gia sư quản lý (422 gắn vào field tutorId).
    const tutorId = await this.resolveManagingTutor(dto, actor);
    // 1. Resolve the student code: if the client supplied one, it must be free — reject the
    // request instead of silently generating a different code. Otherwise, auto-generate one.
    let studentCode: string;
    if (dto.userCode) {
      const taken = await this.repo.getStudentByField({ field: 'userCode', value: dto.userCode });
      if (taken) {
        // Field-level duplicate → 400 with `errors[]` so the FE can mark the code input.
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          message: ERROR_MESSAGES.VALIDATION_FAILED,
          errors: [
            { field: 'userCode', message: ERROR_MESSAGES.STUDENT_CODE_EXISTS, code: 'duplicate' },
          ],
        });
      }
      studentCode = dto.userCode;
    } else {
      studentCode = await this.generateUniqueCode();
    }

    // 2. Split the student's full name into the first/last name columns `users` expects.
    const { firstName, lastName } = this.splitName(dto.studentName);

    // Default password for the student: the one the tutor/admin set, otherwise a random (never returned) one.
    const studentPassword = dto.password ?? generateRandomPassword();

    // Checked before the insert: a taken address gets the generic answer, not a raw unique-key error.
    if (dto.email && (await this.repo.findUserByEmail({ email: dto.email }))) {
      throw new BadRequestException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }

    // 3. Prepare the new PARENT first (when parent info was submitted), so the student's username
    // can avoid the parent's. An existing PARENT is linked by `parentId` and left as-is.
    let parentId: string | null = null;
    let newParent: NewParentInput | null = null;
    let newParentPassword: string | null = null;
    if (dto.parentId) {
      const existingParent = await this.repo.findParentForActor({
        id: dto.parentId,
        ownerTutorId: actor.role === 'TUTOR' ? actor.id : undefined,
      });
      if (!existingParent) throw new NotFoundException(ERROR_MESSAGES.PARENT_NOT_FOUND);
      parentId = existingParent.id;
    } else if (dto.parentName) {
      // A parent email that already belongs to this tutor's PARENT means a sibling: link that one.
      const sibling = await this.findLinkableParentByEmail(dto.parentEmail, tutorId, actor);
      if (sibling) {
        parentId = sibling.id;
      } else {
        const built = await this.buildNewParent(dto, tutorId);
        newParent = built.parent;
        newParentPassword = built.password;
        parentId = newParent.id;
      }
    }

    // 4. Unique username for the student.
    const studentUsername = await this.generateUsernameFromName(
      firstName,
      lastName,
      newParent ? [newParent.username] : [],
    );
    const studentData: NewStudentInput = {
      id: randomUUID(),
      email: dto.email || `${studentUsername}@no-email.local`,
      password: await hashData(studentPassword),
      // Always true: the tutor/admin either generated or typed this password.
      mustChangePassword: true,
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
      tutorId,
    };

    // 5. Create the student, linking the parent (if any) and the creating tutor/admin. A new parent
    // and the student are written in one transaction: no orphan PARENT if the student insert fails.
    const student = newParent
      ? await this.repo.createStudentWithNewParent(newParent, studentData)
      : await this.repo.createStudent(studentData);

    // Credentials are mailed only after the rows are written (best-effort, never fails the create).
    if (newParent && newParentPassword !== null) {
      await sendAccountCreatedMail(this.rmqProducer, {
        userId: newParent.id,
        email: newParent.email,
        username: newParent.username,
        displayName: newParent.firstName,
        password: newParentPassword,
      });
    }
    await sendAccountCreatedMail(this.rmqProducer, {
      userId: studentData.id,
      email: studentData.email,
      username: studentUsername,
      displayName: firstName,
      password: studentPassword,
    });

    return omitPassword(student);
  }

  /** Duplicate parent email → 400 with `errors[]` so the FE can mark the parent email input. */
  private parentEmailTaken(): BadRequestException {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: ERROR_MESSAGES.VALIDATION_FAILED,
      errors: [{ field: 'parentEmail', message: ERROR_MESSAGES.EMAIL_EXISTS, code: 'duplicate' }],
    });
  }

  /**
   * Siblings share one PARENT. If the submitted parent email already belongs to a PARENT the
   * caller may use (ADMIN: any; TUTOR: one of their own), that parent is reused instead of
   * failing on `users.email` UNIQUE. An email held by anyone else is a field-level duplicate.
   */
  private async findLinkableParentByEmail(
    email: string | undefined,
    managingTutorId: string | null,
    actor: UserActor,
  ): Promise<{ id: string } | null> {
    if (!email) return null;
    const existing = await this.repo.findUserByEmail({ email });
    if (!existing) return null;
    const usable =
      existing.role === 'PARENT' &&
      (actor.role === 'ADMIN' || existing.tutorId === managingTutorId);
    if (!usable) throw this.parentEmailTaken();
    return { id: existing.id };
  }

  /** A new PARENT row from the create form (not written yet). */
  private async buildNewParent(
    dto: CreateStudentDto,
    tutorId: string | null,
  ): Promise<{ parent: NewParentInput; password: string }> {
    const { firstName, lastName } = this.splitName(dto.parentName ?? '');
    const password = dto.parentPassword ?? generateRandomPassword();
    const username = await this.generateUsernameFromName(firstName, lastName);
    const parent: NewParentInput = {
      id: randomUUID(),
      // `users.email` is UNIQUE: a parent without an email gets a unique placeholder, like students do.
      email: dto.parentEmail || `${username}@no-email.local`,
      password: await hashData(password),
      // Only a generated parent password is temporary; a parent password typed by the creator is kept.
      mustChangePassword: !dto.parentPassword,
      username,
      firstName,
      lastName,
      userCode: await this.generateUniqueCode(),
      phone: dto.parentPhone ?? null,
      relationship: dto.parentRelationship ?? null,
      gender: dto.parentRelationship === 'FATHER' ? 'MALE' : 'FEMALE',
      tutorId,
    };
    return { parent, password };
  }

  /**
   * Student has no parent yet and the edit form carries parent details: a new PARENT row (not written
   * yet, the caller writes it with the student in one transaction).
   */
  private async buildParentForStudent(
    dto: UpdateStudentDto,
    tutorId: string | null,
  ): Promise<{ parent: NewParentInput; password: string }> {
    const parentPassword = generateRandomPassword();
    const hashedParentPassword = await hashData(parentPassword);
    const { firstName, lastName } =
      dto.parentFirstName || dto.parentLastName
        ? { firstName: dto.parentFirstName ?? '', lastName: dto.parentLastName ?? '' }
        : this.splitName(dto.parentName ?? '');
    const parentUsername = await this.generateUsernameFromName(firstName, lastName);
    // `users.email` is UNIQUE, so a parent without an email gets a unique placeholder (never '').
    const parent: NewParentInput = {
      id: randomUUID(),
      email: dto.parentEmail || `${parentUsername}@no-email.local`,
      password: hashedParentPassword,
      mustChangePassword: true,
      username: parentUsername,
      firstName,
      lastName,
      userCode: await this.generateUniqueCode(),
      phone: dto.parentPhone ?? null,
      relationship: dto.parentRelationship ?? null,
      gender: dto.parentRelationship === 'FATHER' ? 'MALE' : 'FEMALE',
      tutorId,
      address: dto.parentAddress || null,
      district: dto.parentDistrict || null,
      province: dto.parentProvince || null,
    };
    return { parent, password: parentPassword };
  }

  /** PARENT accounts the caller can attach to a student (picker): ADMIN all, TUTOR their own. */
  async findParents(query: GetParentsQueryDto, actor: UserActor) {
    assertStaff(actor);
    const { page, limit, search } = query;
    const { parents, total } = await this.repo.getParents({
      page,
      limit,
      search,
      ownerTutorId: actor.role === 'TUTOR' ? actor.id : undefined,
    });
    return {
      parents: parents.map((p) => ({
        ...p,
        // A placeholder address is an implementation detail, never shown as a real email.
        email: p.email.endsWith('@no-email.local') ? null : p.email,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
      })),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Lớp đã tham gia của từng học sinh, gom theo studentId. */
  private async groupClassesByStudent(studentIds: string[]) {
    const rows = await this.repo.findClassesByStudentIds({ studentIds });
    const grouped = new Map<string, { id: string; name: string; code: string }[]>();
    for (const { studentId, id, name, code } of rows) {
      const list = grouped.get(studentId) ?? [];
      list.push({ id, name, code });
      grouped.set(studentId, list);
    }
    return grouped;
  }

  async findAll(query: GetStudentsQueryDto, actor: UserActor) {
    assertStaff(actor);
    // A tutor's list is always scoped to their own students, whatever `tutorId` the query asks for.
    const scoped: GetStudentsQueryDto =
      actor.role === 'TUTOR' ? { ...query, tutorId: actor.id } : query;
    const { students, pagination } = await this.repo.getAllStudents({ query: scoped });
    const classesById = await this.groupClassesByStudent(students.map((s) => s.id));

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
        tutorId: s.tutorId,
        tutor: toTutorSummary(s.tutor),
        classes: classesById.get(s.id) ?? [],
        classCount: classesById.get(s.id)?.length ?? 0,
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

  async findById(id: string, actor: UserActor) {
    assertStaff(actor);
    assertStudentId(id);
    const user = await this.repo.findById({ id });
    if (!user) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    assertCanManage(actor, user);

    const parent = user.parent;
    const classes = (await this.groupClassesByStudent([user.id])).get(user.id) ?? [];

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
      tutorId: user.tutorId,
      tutor: toTutorSummary(user.tutor),
      classes,
      classCount: classes.length,
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

  async update(id: string, dto: UpdateStudentDto, actor: UserActor) {
    assertStaff(actor);
    assertStudentId(id);
    const student = await this.repo.findById({ id });
    if (!student) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    assertCanManage(actor, student);

    // A TUTOR may create a parent (with the student) but never edit one afterwards: a PARENT account
    // can be shared across tutors, and its email decides who can reset its password. Only ADMIN edits.
    const hasParentField =
      dto.parentName !== undefined ||
      dto.parentLastName !== undefined ||
      dto.parentFirstName !== undefined ||
      dto.parentPhone !== undefined ||
      dto.parentEmail !== undefined ||
      dto.parentRelationship !== undefined ||
      dto.parentAddress !== undefined ||
      dto.parentDistrict !== undefined ||
      dto.parentProvince !== undefined;
    const editsExistingParent = dto.parentId === undefined && hasParentField && !!student.parentId;
    if (actor.role === 'TUTOR' && editsExistingParent) {
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    }
    // Every check and every hash runs first; the DB is written once, at the end, in one transaction.
    let relinkParentId: string | undefined;
    if (dto.parentId !== undefined) {
      const existingParent = await this.repo.findParentForActor({
        id: dto.parentId,
        ownerTutorId: actor.role === 'TUTOR' ? actor.id : undefined,
      });
      if (!existingParent) throw new NotFoundException(ERROR_MESSAGES.PARENT_NOT_FOUND);
      relinkParentId = existingParent.id;
    }
    const parentEmailChanged =
      editsExistingParent &&
      dto.parentEmail !== undefined &&
      dto.parentEmail !== student.parent?.email;
    if (parentEmailChanged) {
      const holder = await this.repo.findUserByEmail({ email: dto.parentEmail! });
      if (holder && holder.id !== student.parentId) throw this.parentEmailTaken();
    }

    // ── student fields ──
    const studentUpdate: Prisma.UserUncheckedUpdateManyInput = {};
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      // Họ/Tên gửi riêng: chỉ ghi đè phần nào có mặt.
      if (dto.firstName !== undefined) studentUpdate.firstName = dto.firstName;
      if (dto.lastName !== undefined) studentUpdate.lastName = dto.lastName;
    } else if (dto.studentName !== undefined) {
      const { firstName, lastName } = this.splitName(dto.studentName);
      studentUpdate.firstName = firstName;
      studentUpdate.lastName = lastName;
    }
    if (dto.tutorId !== undefined && dto.tutorId !== student.tutorId) {
      // Chỉ ADMIN được chuyển học sinh sang gia sư khác.
      if (actor.role !== 'ADMIN')
        throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
      const tutor = await this.repo.findTutorById({ id: dto.tutorId });
      if (!tutor) throw new NotFoundException(ERROR_MESSAGES.TUTOR_NOT_FOUND);
      if (await this.repo.hasEnrollmentWithOtherTutor({ studentId: id, tutorId: tutor.id })) {
        throw new BadRequestException(ERROR_MESSAGES.CLASS_TUTOR_CONFLICT);
      }
      studentUpdate.tutorId = tutor.id;
    }
    if (dto.studentPhone !== undefined) studentUpdate.phone = dto.studentPhone || null;
    if (dto.gender !== undefined) studentUpdate.gender = dto.gender;
    if (dto.birthday !== undefined) studentUpdate.dateOfBirth = dto.birthday;
    if (dto.school !== undefined) studentUpdate.school = dto.school || null;
    if (dto.address !== undefined) studentUpdate.address = dto.address || null;
    if (dto.district !== undefined) studentUpdate.district = dto.district || null;
    if (dto.province !== undefined) studentUpdate.province = dto.province || null;
    if (dto.avatar !== undefined) studentUpdate.avatar = dto.avatar;

    // ── parent fields (prepared, not written) ──
    let parentUpdate: { id: string; data: Prisma.UserUncheckedUpdateManyInput } | undefined;
    let linkParentId: string | undefined = relinkParentId;
    let newParent: { parent: NewParentInput; password: string } | undefined;
    if (relinkParentId === undefined && hasParentField) {
      if (student.parentId) {
        const data: Prisma.UserUncheckedUpdateManyInput = {};
        if (dto.parentFirstName !== undefined || dto.parentLastName !== undefined) {
          if (dto.parentFirstName !== undefined) data.firstName = dto.parentFirstName;
          if (dto.parentLastName !== undefined) data.lastName = dto.parentLastName;
        } else if (dto.parentName !== undefined) {
          const { firstName, lastName } = this.splitName(dto.parentName);
          data.firstName = firstName;
          data.lastName = lastName;
        }
        if (dto.parentPhone !== undefined) data.phone = dto.parentPhone || null;
        if (dto.parentEmail !== undefined) {
          data.email = dto.parentEmail;
          // The new address is unproven: it must be verified again.
          if (parentEmailChanged) data.emailVerified = false;
        }
        if (dto.parentRelationship !== undefined) data.relationship = dto.parentRelationship;
        if (dto.parentAddress !== undefined) data.address = dto.parentAddress || null;
        if (dto.parentDistrict !== undefined) data.district = dto.parentDistrict || null;
        if (dto.parentProvince !== undefined) data.province = dto.parentProvince || null;
        if (Object.keys(data).length > 0) parentUpdate = { id: student.parentId, data };
      } else if (dto.parentName || dto.parentFirstName || dto.parentLastName) {
        // No parent linked yet: reuse the tutor's parent with this email (a sibling), else create one.
        const sibling = await this.findLinkableParentByEmail(
          dto.parentEmail,
          student.tutorId,
          actor,
        );
        if (sibling) {
          linkParentId = sibling.id;
        } else {
          newParent = await this.buildParentForStudent(dto, student.tutorId);
          linkParentId = newParent.parent.id;
        }
      }
    }

    // ── one write: student row, parent row and link together ──
    let updated: Omit<typeof student, 'parent' | 'tutor'> = student;
    const hasStudentWrite = Object.keys(studentUpdate).length > 0;
    if (hasStudentWrite || linkParentId !== undefined || parentUpdate || newParent) {
      updated =
        (await this.repo.applyStudentUpdate({
          studentId: id,
          studentData: studentUpdate,
          parentId: linkParentId,
          parentUpdate,
          newParent: newParent?.parent,
        })) ?? student;
    }

    // Side effects only after the commit.
    if (newParent) {
      await sendAccountCreatedMail(this.rmqProducer, {
        userId: newParent.parent.id,
        email: newParent.parent.email,
        username: newParent.parent.username,
        displayName: newParent.parent.firstName,
        password: newParent.password,
      });
    }
    // An email change must not leave the parent's old sessions alive.
    if (parentEmailChanged && student.parentId) {
      await revokeAllUserSessions(this.rmqProducer, student.parentId);
    }

    return omitPassword(updated);
  }

  async delete(id: string, actor: UserActor) {
    assertStaff(actor);
    assertStudentId(id);
    const student = await this.repo.findById({ id });
    if (!student) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    assertCanManage(actor, student);
    await this.repo.delete({ id });
    // The account is gone: its access/refresh sessions must stop working at once (same as admin/user delete).
    await revokeAllUserSessions(this.rmqProducer, id);
    return { id };
  }

  /** Gia sư (chủ học sinh) hoặc admin đặt lại mật khẩu cho học sinh. Không bao giờ trả về mật khẩu. */
  async setPassword(id: string, password: string, actor: UserActor) {
    assertStaff(actor);
    assertStudentId(id);
    const student = await this.repo.findById({ id });
    if (!student) throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    assertCanManage(actor, student);
    // Revoke first (same as the tutor path): a failure leaves the password unchanged.
    await revokeAllUserSessions(this.rmqProducer, id);
    // An admin-set password is temporary: the student must choose their own at next sign-in.
    await this.repo.update({
      id,
      data: { password: await hashData(password), mustChangePassword: true },
    });
    return { id, passwordUpdated: true };
  }

  /** Phụ huynh xem danh sách con (học sinh có parentId = phụ huynh đang đăng nhập). */
  async findChildren(actor: UserActor) {
    if (actor.role !== 'PARENT') throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    const children = await this.repo.findChildrenByParentId({ parentId: actor.id });
    return children.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      userCode: c.userCode,
      tutorId: c.tutorId,
    }));
  }
}
