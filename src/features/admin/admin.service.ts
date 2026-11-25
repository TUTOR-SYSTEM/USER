import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { randomUUID } from 'node:crypto';
import type {
  CreateManagedUserDto,
  ListManagedUsersQueryDto,
  UpdateManagedUserDto,
  UpdateManagedStudentDto,
} from '@packages/entities/admin';
import {
  checkUuidValid,
  generateCode,
  generateRandomPassword,
  hashData,
  pickFreeUsername,
  revokeAllUserSessions,
  sendAccountCreatedMail,
  usernameBase,
} from '@packages/helpers';
import { RmqProducer } from '../rabbitmq/rmq.producer';
import type { UserActor } from '../user/user.service';
import { AdminRepository, type ManagedRole } from './admin.repository';

type TutorStudentSummary = { id: string; firstName: string; lastName: string };

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly adminRepository: AdminRepository,
    private readonly rmqProducer: RmqProducer,
  ) {}

  // Every public method takes the verified caller (`actor`) and is ADMIN-only: the admin surface
  // manages accounts other than the caller's, so there is no ownership to check instead.

  // ─── Tutors ────────────────────────────────────────────────────────
  async createTutor(dto: CreateManagedUserDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.createManagedUser(dto, 'TUTOR');
  }

  async listTutors(query: ListManagedUsersQueryDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.listManagedUsers('TUTOR', query);
  }

  async getTutor(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.getManagedUser(id, 'TUTOR');
  }

  async updateTutor(id: string, dto: UpdateManagedUserDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.updateManagedUser(id, 'TUTOR', dto);
  }

  async deleteTutor(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.deleteManagedUser(id, 'TUTOR');
  }

  /** Admin đặt mật khẩu mới cho gia sư. Thu hồi mọi phiên đang đăng nhập của gia sư đó. Không trả mật khẩu. */
  async setTutorPassword(id: string, password: string, actor: UserActor) {
    this.assertAdmin(actor);
    this.assertUuid(id);
    await this.getManagedUser(id, 'TUTOR');
    await this.adminRepository.updateByIdAndRole(id, 'TUTOR', {
      password: await hashData(password),
      // An admin-set password is temporary: the tutor must choose their own at next sign-in.
      mustChangePassword: true,
    });
    await revokeAllUserSessions(this.rmqProducer, id);
    return { id, passwordUpdated: true };
  }

  // ─── Parents ───────────────────────────────────────────────────────
  async listParents(query: ListManagedUsersQueryDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.listManagedUsers('PARENT', query);
  }

  async updateParent(id: string, dto: UpdateManagedUserDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.updateManagedUser(id, 'PARENT', dto);
  }

  async deleteParent(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.deleteManagedUser(id, 'PARENT');
  }

  async setParentPassword(id: string, password: string, actor: UserActor) {
    this.assertAdmin(actor);
    this.assertUuid(id);
    await this.getManagedUser(id, 'PARENT');
    await this.adminRepository.updateByIdAndRole(id, 'PARENT', {
      password: await hashData(password),
      // Mật khẩu do admin đặt là tạm thời: phụ huynh phải tự đặt lại khi đăng nhập.
      mustChangePassword: true,
    });
    await revokeAllUserSessions(this.rmqProducer, id);
    return { id, passwordUpdated: true };
  }

  // ─── Students ──────────────────────────────────────────────────────
  async createStudent(dto: CreateManagedUserDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.createManagedUser(dto, 'STUDENT');
  }

  async listStudents(query: ListManagedUsersQueryDto, actor: UserActor) {
    this.assertAdmin(actor);
    return this.listManagedUsers('STUDENT', query);
  }

  async getStudent(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.getStudentDetail(id);
  }

  private async getStudentDetail(id: string) {
    this.assertUuid(id);
    const detail = await this.adminRepository.findStudentDetail(id);
    if (!detail) {
      throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    }
    const { parentId, ...row } = detail;

    const parent = parentId ? await this.adminRepository.findParentInfo(parentId) : null;
    return { ...this.mapRow(row), parent };
  }

  async updateStudent(id: string, dto: UpdateManagedStudentDto, actor: UserActor) {
    this.assertAdmin(actor);
    if (dto.userCode) {
      const [existing] = await this.adminRepository.findByUserCode(dto.userCode.trim());
      if (existing && existing.id !== id) {
        throw this.fieldConflict('userCode', ERROR_MESSAGES.STUDENT_CODE_EXISTS);
      }
    }
    if (dto.parentId) {
      const exists = await this.adminRepository.existsWithRole(dto.parentId, 'PARENT');
      if (!exists) throw new NotFoundException(ERROR_MESSAGES.PARENT_NOT_FOUND);
    }
    if (dto.tutorId) {
      const exists = await this.adminRepository.existsWithRole(dto.tutorId, 'TUTOR');
      if (!exists) throw new NotFoundException(ERROR_MESSAGES.TUTOR_NOT_FOUND);
    }
    if (dto.tutorId !== undefined) {
      const current = await this.adminRepository.findStudentDetail(id);
      if (
        current &&
        current.tutorId !== dto.tutorId &&
        (await this.adminRepository.hasEnrollmentWithOtherTutor({
          studentId: id,
          tutorId: dto.tutorId,
        }))
      ) {
        throw new BadRequestException(ERROR_MESSAGES.CLASS_TUTOR_CONFLICT);
      }
    }

    await this.updateManagedUser(id, 'STUDENT', dto);
    return this.getStudentDetail(id);
  }

  async deleteStudent(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.deleteManagedUser(id, 'STUDENT');
  }

  /**
   * Duplicate on one field (email / username / userCode). Returned as 400 with `errors[]` so the
   * FE maps it onto that input, same shape as Zod validation failures. Admin-only endpoints, so
   * naming the duplicated field is intentional (unlike the public register flow).
   */
  private fieldConflict(field: string, message: string): BadRequestException {
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: ERROR_MESSAGES.VALIDATION_FAILED,
      errors: [{ field, message, code: 'duplicate' }],
    });
  }

  // ─── Shared implementation ─────────────────────────────────────────
  private async createManagedUser(dto: CreateManagedUserDto, role: ManagedRole) {
    this.logger.log(`Admin creating a ${role} account (${dto.email})`);

    const email = dto.email.trim().toLowerCase();
    const [existingByEmail] = await this.adminRepository.findByEmail(email);
    if (existingByEmail) {
      throw this.fieldConflict('email', ERROR_MESSAGES.EMAIL_EXISTS);
    }

    const username = dto.username?.trim()
      ? await this.ensureUniqueUsername(dto.username.trim())
      : await this.generateUsername(dto.firstName, dto.lastName);

    const userCode = role === 'TUTOR' ? await this.generateUniqueUserCode() : undefined;
    const plainPassword = dto.password ?? generateRandomPassword();
    const hashedPassword = await hashData(plainPassword);

    const created = await this.adminRepository.create({
      id: randomUUID(),
      email,
      username,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: hashedPassword,
      // Admin/tutor-created accounts (generated or typed password) must change it at first sign-in.
      mustChangePassword: true,
      phone: dto.phone,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      school: dto.school,
      subjects: this.joinSubjects(dto.subjects),
      description: dto.description,
      isActive: dto.isActive,
      role,
      ...(userCode ? { userCode } : {}),
    });
    await sendAccountCreatedMail(this.rmqProducer, {
      userId: created.id,
      email,
      username,
      displayName: dto.firstName,
      password: plainPassword,
    });
    return this.mapRow(created);
  }

  private async listManagedUsers(role: ManagedRole, query: ListManagedUsersQueryDto) {
    const { rows, pagination } = await this.adminRepository.list({ role, ...query });
    const key = role === 'TUTOR' ? 'tutors' : role === 'PARENT' ? 'parents' : 'students';
    const mapped = rows.map((row) => this.mapRow(row));
    if (role === 'TUTOR') {
      return { [key]: await this.attachTutorLoad(mapped), pagination };
    }
    return { [key]: mapped, pagination };
  }

  /** Gắn `classCount`, `studentCount` và toàn bộ `students` (theo tên) cho từng gia sư trong trang hiện tại. */
  private async attachTutorLoad<T extends { id: string }>(tutors: T[]) {
    const ids = tutors.map((t) => t.id);
    const [classRows, studentRows] = await Promise.all([
      this.adminRepository.countClassesByTutors(ids),
      this.adminRepository.findStudentsByTutors(ids),
    ]);

    const classCounts = new Map(classRows.map((r) => [r.tutorId, r.classCount]));
    const students = new Map<string, TutorStudentSummary[]>();
    for (const s of studentRows) {
      if (!s.tutorId) continue;
      const list = students.get(s.tutorId) ?? [];
      list.push({ id: s.id, firstName: s.firstName, lastName: s.lastName });
      students.set(s.tutorId, list);
    }

    return tutors.map((tutor) => {
      const list = students.get(tutor.id) ?? [];
      return {
        ...tutor,
        classCount: classCounts.get(tutor.id) ?? 0,
        studentCount: list.length,
        students: list,
      };
    });
  }

  private async getManagedUser(id: string, role: ManagedRole) {
    this.assertUuid(id);
    const row = await this.adminRepository.findByIdAndRole(id, role);
    if (!row) {
      throw new NotFoundException(
        role === 'TUTOR' ? ERROR_MESSAGES.TUTOR_NOT_FOUND : ERROR_MESSAGES.STUDENT_NOT_FOUND,
      );
    }
    return this.mapRow(row);
  }

  private async updateManagedUser(
    id: string,
    role: ManagedRole,
    dto: UpdateManagedUserDto | UpdateManagedStudentDto,
  ) {
    this.assertUuid(id);
    const existingRow = await this.getManagedUser(id, role);

    // A new address has not been proven yet, and the old sessions belonged to the old owner of it.
    let emailChanged = false;
    if (dto.email) {
      const email = dto.email.trim().toLowerCase();
      const [existing] = await this.adminRepository.findByEmail(email);
      if (existing && existing.id !== id) {
        throw this.fieldConflict('email', ERROR_MESSAGES.EMAIL_EXISTS);
      }
      dto = { ...dto, email };
      emailChanged = email !== existingRow.email;
    }
    if (dto.username) {
      const [existing] = await this.adminRepository.findByUsername(dto.username.trim());
      if (existing && existing.id !== id) {
        throw this.fieldConflict('username', ERROR_MESSAGES.USERNAME_EXISTS);
      }
    }

    const { subjects, ...rest } = dto;
    const writeData = {
      ...rest,
      ...(emailChanged ? { emailVerified: false } : {}),
      // `subjects` arrives as string[] but the column stores a comma-joined string;
      // an empty array or null clears it.
      ...(subjects !== undefined
        ? { subjects: subjects && subjects.length ? this.joinSubjects(subjects) : null }
        : {}),
    };

    const updated = await this.adminRepository.updateByIdAndRole(id, role, writeData);
    if (!updated) {
      throw new NotFoundException(
        role === 'TUTOR' ? ERROR_MESSAGES.TUTOR_NOT_FOUND : ERROR_MESSAGES.STUDENT_NOT_FOUND,
      );
    }
    // A deactivated account must not keep any of its sessions alive.
    if (dto.isActive === false || emailChanged) await revokeAllUserSessions(this.rmqProducer, id);
    return this.mapRow(updated);
  }

  private async deleteManagedUser(id: string, role: ManagedRole) {
    this.assertUuid(id);
    const notFound = () =>
      new NotFoundException(
        role === 'TUTOR'
          ? ERROR_MESSAGES.TUTOR_NOT_FOUND
          : role === 'PARENT'
            ? ERROR_MESSAGES.PARENT_NOT_FOUND
            : ERROR_MESSAGES.STUDENT_NOT_FOUND,
      );
    const existing = await this.adminRepository.findByIdAndRole(id, role);
    if (!existing) throw notFound();
    // users.tutor_id / users.parent_id cascade on delete — refuse while students are linked.
    if ((await this.adminRepository.countLinkedUsers(id)) > 0) {
      throw new ConflictException(ERROR_MESSAGES.USER_HAS_LINKED_ACCOUNTS);
    }
    const deleted = await this.adminRepository.deleteByIdAndRole(id, role);
    if (!deleted) throw notFound();
    await revokeAllUserSessions(this.rmqProducer, id);
    return { id: deleted.id };
  }

  // ─── Helpers ───────────────────────────────────────────────────────
  private assertAdmin(actor: UserActor): void {
    if (actor.role !== 'ADMIN') throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  private assertUuid(id: string) {
    if (!checkUuidValid({ data: id })) {
      throw new BadRequestException(ERROR_MESSAGES.ADMIN_INVALID_ID);
    }
  }

  /** The DB column stores subjects as a comma-joined string; the API exposes an array. */
  private joinSubjects(subjects?: string[]): string | undefined {
    if (!subjects || subjects.length === 0) return undefined;
    return subjects
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
  }

  private splitSubjects(value: string | null): string[] {
    if (!value) return [];
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Turn a raw DB row into the API shape (subjects string → string[]). */
  private mapRow<T extends { subjects: string | null }>(
    row: T,
  ): Omit<T, 'subjects'> & {
    subjects: string[];
  } {
    return { ...row, subjects: this.splitSubjects(row.subjects) };
  }

  private async ensureUniqueUsername(username: string): Promise<string> {
    const [existing] = await this.adminRepository.findByUsername(username);
    if (existing) {
      throw this.fieldConflict('username', ERROR_MESSAGES.USERNAME_EXISTS);
    }
    return username;
  }

  private async generateUsername(firstName: string, lastName: string): Promise<string> {
    const username = await pickFreeUsername(
      usernameBase(firstName, lastName),
      async (candidate) => (await this.adminRepository.findByUsername(candidate)).length > 0,
    );
    if (username) return username;
    throw new ConflictException(
      `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: ${firstName} ${lastName}`,
    );
  }

  private async generateUniqueUserCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = generateCode(6);
      const [existing] = await this.adminRepository.findByUserCode(code);
      if (!existing) return code;
    }
    throw new ConflictException(ERROR_MESSAGES.UNABLE_TO_GENERATE_USER_CODE);
  }
}
