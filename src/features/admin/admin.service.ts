import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { checkUuidValid, generateCode, hashData, revokeAllUserSessions } from '@packages/helpers';
import { RmqProducer } from '../rabbitmq/rmq.producer';
import type { UserActor } from '../user/user.service';
import { AdminRepository, type ManagedRole } from './admin.repository';

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
    const { parentId, ...row } = (await this.adminRepository.findStudentDetail(id)) ?? {};
    if (!row.id) {
      throw new NotFoundException(ERROR_MESSAGES.STUDENT_NOT_FOUND);
    }

    const parent = parentId ? await this.adminRepository.findParentInfo(parentId) : null;
    return { ...this.mapRow(row), parent };
  }

  async updateStudent(id: string, dto: UpdateManagedStudentDto, actor: UserActor) {
    this.assertAdmin(actor);
    if (dto.userCode) {
      const [existing] = await this.adminRepository.findByUserCode(dto.userCode.trim());
      if (existing && existing.id !== id) {
        throw new ConflictException(
          `${ERROR_MESSAGES.STUDENT_CODE_EXISTS}: ${dto.userCode.trim()}`,
        );
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

    await this.updateManagedUser(id, 'STUDENT', dto);
    return this.getStudentDetail(id);
  }

  async deleteStudent(id: string, actor: UserActor) {
    this.assertAdmin(actor);
    return this.deleteManagedUser(id, 'STUDENT');
  }

  // ─── Shared implementation ─────────────────────────────────────────
  private async createManagedUser(dto: CreateManagedUserDto, role: ManagedRole) {
    this.logger.log(`Admin creating a ${role} account (${dto.email})`);

    const email = dto.email.trim().toLowerCase();
    const [existingByEmail] = await this.adminRepository.findByEmail(email);
    if (existingByEmail) {
      throw new ConflictException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }

    const username = dto.username?.trim()
      ? await this.ensureUniqueUsername(dto.username.trim())
      : await this.generateUsername(dto.firstName, dto.lastName);

    const userCode = role === 'TUTOR' ? await this.generateUniqueUserCode() : undefined;
    const hashedPassword = await hashData(dto.password);

    const created = await this.adminRepository.create({
      id: randomUUID(),
      email,
      username,
      firstName: dto.firstName,
      lastName: dto.lastName,
      password: hashedPassword,
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
    return this.mapRow(created);
  }

  private async listManagedUsers(role: ManagedRole, query: ListManagedUsersQueryDto) {
    const { rows, pagination } = await this.adminRepository.list({ role, ...query });
    const key = role === 'TUTOR' ? 'tutors' : 'students';
    return { [key]: rows.map((row) => this.mapRow(row)), pagination };
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
    await this.getManagedUser(id, role);

    if (dto.email) {
      const email = dto.email.trim().toLowerCase();
      const [existing] = await this.adminRepository.findByEmail(email);
      if (existing && existing.id !== id) {
        throw new ConflictException(`${ERROR_MESSAGES.EMAIL_EXISTS}: ${email}`);
      }
      dto = { ...dto, email };
    }
    if (dto.username) {
      const [existing] = await this.adminRepository.findByUsername(dto.username.trim());
      if (existing && existing.id !== id) {
        throw new ConflictException(`${ERROR_MESSAGES.USERNAME_EXISTS}: ${dto.username.trim()}`);
      }
    }

    const { subjects, ...rest } = dto;
    const writeData = {
      ...rest,
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
    if (dto.isActive === false) await revokeAllUserSessions(this.rmqProducer, id);
    return this.mapRow(updated);
  }

  private async deleteManagedUser(id: string, role: ManagedRole) {
    this.assertUuid(id);
    const notFound = () =>
      new NotFoundException(
        role === 'TUTOR' ? ERROR_MESSAGES.TUTOR_NOT_FOUND : ERROR_MESSAGES.STUDENT_NOT_FOUND,
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
      throw new ConflictException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }
    return username;
  }

  private async generateUsername(firstName: string, lastName: string): Promise<string> {
    const base = `${lastName}${firstName}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '');

    for (let i = 0; i < 10; i++) {
      const candidate = i === 0 ? base : `${base}${i}`;
      const [existing] = await this.adminRepository.findByUsername(candidate);
      if (!existing) return candidate;
    }
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
