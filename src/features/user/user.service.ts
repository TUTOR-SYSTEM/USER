import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { UserRepository } from './user.repository';
import { RmqProducer } from '../rabbitmq/rmq.producer';
import type {
  ChangePasswordValues,
  CreateUserInput,
  CreateUserResponseDto,
  GetUsersQueryDto,
  UpdateUserDto,
  UserDataFieldDto,
  User,
} from '@packages/entities/user';
import { checkUuidValid, compareData, hashData, loginSessionRedisKey } from '@packages/helpers';
import { ERROR_MESSAGES } from 'src/data/constants';

/**
 * The verified caller of an operation: the JWT user on HTTP (`@CurrentUser()`), or the
 * `actorId`/`actorRole` the gateway forwards on RPC. Every authorization decision below is made
 * against this, never against the target id alone.
 */
export interface UserActor {
  id: string;
  role: string;
}

/**
 * Maps the request user (`@CurrentUser()`) to the actor shape the service checks. A missing field
 * becomes '' so the service rejects the call instead of matching by accident.
 */
export const actorFrom = (user: { id?: string; role?: string }): UserActor => ({
  id: user.id ?? '',
  role: user.role ?? '',
});

/** Fields only an admin (`PUT /users/:id`) may change — never via self-update (privilege escalation). */
const SELF_UPDATE_RESTRICTED_FIELDS = [
  'role',
  'isActive',
  'userCode',
  'parentId',
  'tutorId',
  'googleId',
  'facebookId',
] as const satisfies readonly (keyof UpdateUserDto)[];

function omitPassword<T extends { password?: unknown }>(user: T): Omit<T, 'password'> {
  const safe: Partial<T> = { ...user };
  delete safe.password;
  return safe as Omit<T, 'password'>;
}

/**
 * Strips columns that must never be written through a generic update: `id` (identity) and
 * `password` (hashed only by the password flows). `dateOfBirth` arrives as an ISO string over RMQ
 * (JSON), but the timestamp column needs a Date.
 */
function sanitizeUpdate(data: UpdateUserDto): UpdateUserDto {
  const safe: Partial<Record<string, unknown>> = { ...data };
  delete safe.id;
  delete safe.password;
  if (typeof safe.dateOfBirth === 'string') safe.dateOfBirth = new Date(safe.dateOfBirth);
  return safe;
}

function generateUserCode(): string {
  return randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly searchableFields = ['id', 'email', 'username', 'phone', 'userCode'] as const;

  constructor(
    private readonly userRepo: UserRepository,
    private readonly rmqProducer: RmqProducer,
  ) {}

  // TODO: generate unique username from first/last name
  async generateUsername(firstName: string, lastName: string): Promise<string> {
    const baseUsername = `${lastName}${firstName}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '');

    for (let i = 0; i < 10; i++) {
      const candidate = i === 0 ? baseUsername : `${baseUsername}${i}`;
      const existing = await this.getUserByField({ field: 'username', value: candidate });
      if (existing.length === 0) return candidate;
    }

    throw new ConflictException(
      `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME} for "${firstName} ${lastName}" after 10 attempts`,
    );
  }

  // TODO: get and filter users, paginated
  async getUsersService(query: GetUsersQueryDto) {
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const whereClause = this.userRepo.buildUserListConditions(query);

    const [total, rows] = await Promise.all([
      this.userRepo.countUsers(whereClause),
      this.userRepo.paginateUsers(whereClause, limit, offset),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    const data = rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: `${row.firstName} ${row.lastName}`.trim(),
      role: row.role ?? 'STUDENT',
      status: row.isActive === true ? 'active' : 'inactive',
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    }));

    return {
      data,
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages,
      },
    };
  }

  /**
   * Read access: ADMIN, the user themself, or a TUTOR reading one of their own STUDENTs. Any other
   * caller gets a 403. `expectedRole` makes a wrong-role id look like "not found" (null).
   */
  async getDetailUserService({
    id,
    actor,
    expectedRole,
  }: {
    id: string;
    actor: UserActor;
    expectedRole?: string;
  }): Promise<Omit<User, 'password'> | null> {
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);
    const user = await this.userRepo.findById(id);
    if (!user || (expectedRole !== undefined && user.role !== expectedRole)) return null;

    const canRead =
      actor.role === 'ADMIN' ||
      actor.id === user.id ||
      (actor.role === 'TUTOR' && user.role === 'STUDENT' && user.tutorId === actor.id);
    if (!canRead) throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);

    return omitPassword(user);
  }

  // TODO: get users by searchable field
  async getUserByField(userDataFieldDto: UserDataFieldDto): Promise<User[]> {
    if (
      !this.searchableFields.includes(
        userDataFieldDto.field as (typeof this.searchableFields)[number],
      )
    ) {
      this.logger.warn(`Status: 400 - Unsupported field: ${userDataFieldDto.field}`);
      throw new BadRequestException(
        `${ERROR_MESSAGES.UNSUPPORTED_FIELD}: ${userDataFieldDto.field}`,
      );
    }
    // A non-uuid value would reach a uuid column and fail inside Postgres (500 with SQL).
    if (userDataFieldDto.field === 'id' && !checkUuidValid({ data: userDataFieldDto.value })) {
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);
    }

    const users = await this.userRepo.findByField(userDataFieldDto.field, userDataFieldDto.value);
    return users.map((user) => ({ ...user, role: user.role ?? 'STUDENT' }));
  }

  /** Same as `getUserByField` but safe to return to clients (no password hash). */
  async findUsersByFieldPublic(dto: UserDataFieldDto) {
    return (await this.getUserByField(dto)).map((user) => omitPassword(user));
  }

  // TODO: create user, check email/username uniqueness
  async createUserService(createUserDto: CreateUserInput): Promise<CreateUserResponseDto> {
    const { email, firstName, lastName, password, username } = createUserDto;
    let resolvedUsername = username?.trim();

    const [existingByEmail, existingByUsername] = await Promise.all([
      this.getUserByField({ field: 'email', value: email }),
      resolvedUsername && this.getUserByField({ field: 'username', value: resolvedUsername }),
    ]);

    if (existingByEmail.length > 0) {
      this.logger.warn(`Status: 400 - Email already exists: ${email}`);
      throw new BadRequestException(`${ERROR_MESSAGES.EMAIL_EXISTS}: ${email}`);
    }
    if (Array.isArray(existingByUsername) && existingByUsername.length > 0) {
      this.logger.warn(`Status: 400 - Username already exists: ${resolvedUsername}`);
      throw new BadRequestException(`${ERROR_MESSAGES.USERNAME_EXISTS}: ${resolvedUsername}`);
    }

    const id = randomUUID();
    const hashedPassword = await hashData(password);
    const role = createUserDto.role ?? 'STUDENT';
    let userCode: string | undefined;
    if (role === 'TUTOR') {
      userCode = generateUserCode();
      for (let i = 0; i < 5; i++) {
        const existing = await this.userRepo.findUserCode(userCode);
        if (!existing) break;
        userCode = generateUserCode();
      }
    }

    if (!username) {
      resolvedUsername = await this.generateUsername(firstName, lastName);
    }

    const user = await this.userRepo.create({
      id,
      ...(userCode ? { userCode } : {}),
      email,
      username: resolvedUsername!,
      firstName,
      lastName,
      password: hashedPassword,
      role,
    });

    return {
      message: 'User created successfully',
      data: {
        email: user.email,
        fullName: `${user.firstName} ${user.lastName}`.trim(),
      },
    };
  }

  /**
   * Password write used by the change-password and reset-password flows. Any live login session
   * of the user is revoked afterwards, so refresh tokens and gateway access stop working.
   */
  async updateUserPasswordService({ id, password }: { id: string; password: string }) {
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const [user] = await this.getUserByField({
      field: 'id',
      value: id,
    });
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const hashedPassword = await hashData(password);
    const updated = await this.userRepo.updatePassword(id, hashedPassword);
    await this.revokeLoginSession(id);
    return updated && omitPassword(updated);
  }

  /**
   * Admin-only write (`PUT /users/:id`, `user.updateUserByAdmin`). `expectedRole` lets the
   * `/admin/tutors` and `/admin/students` surfaces refuse to touch the other role.
   */
  async updateUserService({
    id,
    data,
    actor,
    expectedRole,
  }: {
    id: string;
    data: UpdateUserDto;
    actor: UserActor;
    expectedRole?: string;
  }) {
    this.assertAdmin(actor);
    return this.applyUserUpdate({ id, data, expectedRole });
  }

  /**
   * Self-update (`PUT /users`) or admin edit of a user through the student surface
   * (`PUT /students/:id`). Only the target themself or an ADMIN may call it. A STUDENT may not
   * change their own `firstName`/`lastName` — only an admin may rename a student.
   */
  async updateOwnProfileService({
    id,
    actor,
    data,
  }: {
    id: string;
    actor: UserActor;
    data: UpdateUserDto;
  }) {
    this.assertSelfOrAdmin(actor, id);
    if (SELF_UPDATE_RESTRICTED_FIELDS.some((field) => data[field] !== undefined)) {
      throw new BadRequestException(ERROR_MESSAGES.CANNOT_UPDATE_RESTRICTED_FIELDS);
    }
    if (
      actor.id === id &&
      actor.role === 'STUDENT' &&
      (data.firstName !== undefined || data.lastName !== undefined)
    ) {
      throw new BadRequestException(ERROR_MESSAGES.STUDENT_CANNOT_UPDATE_NAME);
    }

    return this.applyUserUpdate({ id, data });
  }

  // TODO: toggle user active status by id (admin only)
  async updateStatusUserService({ id, actor }: { id: string; actor: UserActor }) {
    this.assertAdmin(actor);
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const user = await this.userRepo.findById(id);
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    if (actor.id === id) {
      throw new ConflictException(ERROR_MESSAGES.CANNOT_MODIFY_OWN_STATUS);
    }

    const nextActive = !user.isActive;
    if (!nextActive) await this.assertNotLastActiveAdmin(user);

    const updated = await this.userRepo.update(id, { isActive: nextActive });
    if (!nextActive) await this.revokeLoginSession(id);
    return updated && omitPassword(updated);
  }

  // TODO: delete user by id, admin only
  async deleteUserByAdminService({
    id,
    actor,
    expectedRole,
  }: {
    id: string;
    actor: UserActor;
    expectedRole?: string;
  }) {
    this.assertAdmin(actor);
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const user = await this.userRepo.findById(id);
    if (!user || (expectedRole !== undefined && user.role !== expectedRole)) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    if (actor.id === id) {
      throw new ConflictException(ERROR_MESSAGES.CANNOT_MODIFY_OWN_STATUS);
    }
    await this.assertNotLastActiveAdmin(user);
    // The FKs `users.tutor_id` / `users.parent_id` cascade on delete: deleting a tutor or parent
    // would silently delete every student linked to them. Refuse until those links are moved.
    await this.assertNoLinkedAccounts(id);

    await this.userRepo.delete(id);
    await this.revokeLoginSession(id);
    return { id };
  }

  // TODO: change password, verify current password first
  async changePasswordService(userId: string, dto: ChangePasswordValues) {
    const user = await this.userRepo.findWithPassword(userId);
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const isMatch = await compareData(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException(ERROR_MESSAGES.CURRENT_PASSWORD_INCORRECT);
    }

    await this.updateUserPasswordService({ id: userId, password: dto.newPassword });
    return { message: 'Password changed successfully' };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private assertAdmin(actor: UserActor): void {
    if (actor.role !== 'ADMIN') throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  private assertSelfOrAdmin(actor: UserActor, targetId: string): void {
    if (actor.role === 'ADMIN') return;
    if (actor.id !== '' && actor.id === targetId) return;
    throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  /** Deletes `session:{userId}` in third-service's Redis. Awaited: a revoke must not fail silently. */
  private async revokeLoginSession(userId: string): Promise<void> {
    await this.rmqProducer.emit('redis.del', { keys: [loginSessionRedisKey(userId)] });
  }

  /** Refuses to deactivate or delete the only active admin, which would lock everyone out. */
  private async assertNotLastActiveAdmin(target: {
    role: string | null;
    isActive: boolean | null;
  }): Promise<void> {
    if (target.role !== 'ADMIN' || !target.isActive) return;
    if ((await this.userRepo.countActiveAdmins()) <= 1) {
      throw new ConflictException(ERROR_MESSAGES.LAST_ADMIN_CANNOT_BE_REMOVED);
    }
  }

  private async assertNoLinkedAccounts(id: string): Promise<void> {
    if ((await this.userRepo.countLinkedUsers(id)) > 0) {
      throw new ConflictException(ERROR_MESSAGES.USER_HAS_LINKED_ACCOUNTS);
    }
  }

  /** `tutorId`/`parentId` must point at an existing account of the right role, never at self. */
  private async assertLinkTarget(
    selfId: string,
    targetId: string,
    expectedRole: 'TUTOR' | 'PARENT',
  ): Promise<void> {
    if (targetId === selfId) throw new BadRequestException(ERROR_MESSAGES.INVALID_LINK_TARGET);
    const target = await this.userRepo.findById(targetId);
    if (!target || target.role !== expectedRole) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_LINK_TARGET);
    }
  }

  /** Shared write behind every update path: uuid, existence, uniqueness and link checks. */
  private async applyUserUpdate({
    id,
    data,
    expectedRole,
  }: {
    id: string;
    data: UpdateUserDto;
    expectedRole?: string;
  }) {
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const user = await this.userRepo.findById(id);
    if (!user || (expectedRole !== undefined && user.role !== expectedRole)) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    // Pre-check unique columns so a clash is a 400, not a raw Postgres 23505 → 500.
    if (data.email !== undefined && data.email !== user.email) {
      const taken = await this.getUserByField({ field: 'email', value: data.email });
      if (taken.length > 0) throw new BadRequestException(ERROR_MESSAGES.EMAIL_EXISTS);
    }
    if (data.username !== undefined && data.username !== user.username) {
      const taken = await this.getUserByField({ field: 'username', value: data.username });
      if (taken.length > 0) throw new BadRequestException(ERROR_MESSAGES.USERNAME_EXISTS);
    }
    if (data.parentId) await this.assertLinkTarget(id, data.parentId, 'PARENT');
    if (data.tutorId) await this.assertLinkTarget(id, data.tutorId, 'TUTOR');

    const updated = await this.userRepo.update(id, sanitizeUpdate(data));
    return updated && omitPassword(updated);
  }
}
