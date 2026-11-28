import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { UserRepository } from './user.repository';
import { RmqProducer } from '../rabbitmq/rmq.producer';
import type {
  ChangePasswordValues,
  CreateUserInput,
  CreateUserResponseDto,
  GetUsersQueryDto,
  ManagedUserListItem,
  ManagedUsersListDto,
  PublicUser,
  UpdateUserDto,
  UserDataFieldDto,
  User,
} from '@packages/entities/user';
import {
  checkUuidValid,
  compareData,
  generateRandomPassword,
  sendAccountCreatedMail,
  pickFreeUsername,
  usernameBase,
  hashData,
  hashRefreshToken,
  refreshHashRedisKey,
  revokeAllUserSessions,
  sessionRedisKey,
  signRefreshToken,
} from '@packages/helpers';
import { getJwtTokensConfig } from '@packages/configs/jwt-sign.config';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
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

/** Fields only an admin (`PUT /user/updateUserByAdmin/:id`) may change — never via self-update (privilege escalation). */
const SELF_UPDATE_RESTRICTED_FIELDS = [
  'role',
  'isActive',
  'userCode',
  'parentId',
  'tutorId',
  'googleId',
  'facebookId',
] as const satisfies readonly (keyof UpdateUserDto)[];

/** Wrong "current password" answers allowed per account per window (change password / change email). */
const CURRENT_PASSWORD_MAX_ATTEMPTS = 5;
const CURRENT_PASSWORD_WINDOW_SECONDS = 900;
const currentPasswordAttemptsRedisKey = (userId: string) => `current-password-attempts:${userId}`;

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

function omitPassword<T extends { password?: unknown }>(user: T): Omit<T, 'password'> {
  const safe: Partial<T> = { ...user };
  delete safe.password;
  return safe as Omit<T, 'password'>;
}

/** Trims and lowercases an email so one mailbox cannot become two accounts. */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Strips columns that must never be written through a generic update: `id` (identity) and
 * `password` (hashed only by the password flows). `dateOfBirth` arrives as an ISO string over RMQ
 * (JSON), but the timestamp column needs a Date.
 */
function sanitizeUpdate(data: UpdateUserDto): UpdateUserDto {
  const safe: Partial<Record<string, unknown>> = { ...data };
  delete safe.id;
  delete safe.password;
  delete safe.currentPassword;
  // Set only by the auth flows (verify-email, OAuth, reset-password) — never from a caller's body.
  delete safe.emailVerified;
  if (typeof safe.dateOfBirth === 'string') safe.dateOfBirth = new Date(safe.dateOfBirth);
  return safe;
}

/** Keeps only the optional create fields the caller actually sent (empty strings count as unset). */
function providedCreateFields(dto: CreateUserInput): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  const candidates = [
    'phone',
    'gender',
    'dateOfBirth',
    'school',
    'description',
    'subjects',
    'address',
    'district',
    'province',
    'avatar',
    'relationship',
    'gradesId',
  ] as const;
  for (const key of candidates) {
    const value = dto[key];
    if (value !== undefined && value !== null && value !== '') picked[key] = value;
  }
  if (dto.isActive !== undefined) picked.isActive = dto.isActive;
  return picked;
}

function generateUserCode(): string {
  return randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
}

/** Row → list item for the paginated user list (UI `ApiManagedUser`). */
function toListItem(row: {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatar: string | null;
  role: string | null;
  isActive: boolean | null;
  createdAt: Date;
}): ManagedUserListItem {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone ?? null,
    avatar: row.avatar ?? null,
    role: row.role ?? 'STUDENT',
    isActive: row.isActive ?? false,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly searchableFields = ['id', 'email', 'username', 'phone', 'userCode'] as const;

  constructor(
    private readonly userRepo: UserRepository,
    private readonly rmqProducer: RmqProducer,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // TODO: generate unique username from first/last name
  async generateUsername(firstName: string, lastName: string): Promise<string> {
    const username = await pickFreeUsername(
      usernameBase(firstName, lastName),
      async (candidate) =>
        (await this.getUserByField({ field: 'username', value: candidate })).length > 0,
    );
    if (username) return username;

    throw new ConflictException(
      `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: ${firstName} ${lastName}`,
    );
  }

  /** `user.getUsers` / `GET /user/getUsers`: ADMIN only. Returns `{ users, pagination }` (UI shape). */
  async getUsersService(query: GetUsersQueryDto, actor: UserActor): Promise<ManagedUsersListDto> {
    this.assertAdmin(actor);
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const whereClause = this.userRepo.buildUserListConditions(query);

    const [total, rows] = await Promise.all([
      this.userRepo.countUsers(whereClause),
      this.userRepo.paginateUsers(whereClause, limit, offset),
    ]);

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      users: rows.map(toListItem),
      pagination: { total, page, limit, totalPages },
    };
  }

  /**
   * Read access: ADMIN, the user themself, or a TUTOR reading one of their own STUDENTs. Any other
   * caller gets a 403. A missing user, or one with a different `expectedRole`, is a 404 — never a
   * 200 with `null`.
   */
  async getDetailUserService({
    id,
    actor,
    expectedRole,
  }: {
    id: string;
    actor: UserActor;
    expectedRole?: string;
  }): Promise<PublicUser> {
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);
    const user = await this.userRepo.findById(id);
    if (!user || (expectedRole !== undefined && user.role !== expectedRole)) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

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

    const value =
      userDataFieldDto.field === 'email'
        ? normalizeEmail(userDataFieldDto.value)
        : userDataFieldDto.value;
    const users = await this.userRepo.findByField(userDataFieldDto.field, value);
    return users.map((user) => ({ ...user, role: user.role ?? 'STUDENT' }));
  }

  /** ADMIN-only lookup used by `GET /user/getUserByField` and `user.getUserByField`. */
  async findUsersByFieldPublic(dto: UserDataFieldDto, actor: UserActor): Promise<PublicUser[]> {
    this.assertAdmin(actor);
    return (await this.getUserByField(dto)).map((user) => omitPassword(user));
  }

  /**
   * RPC entry point for `user.createUser`. ADMIN may create any role; TUTOR may only create
   * STUDENT accounts (role is forced, never taken from the payload); everyone else gets 403.
   */
  async createUserByActorService(
    createUserDto: CreateUserInput,
    actor: UserActor,
  ): Promise<CreateUserResponseDto> {
    if (actor.role === 'ADMIN')
      return this.createUserService(createUserDto, { sendCredentials: true });
    if (actor.role === 'TUTOR' && actor.id !== '') {
      // The student belongs to the tutor who created it: without `tutorId` the tutor could not
      // read or manage the account afterwards.
      return this.createUserService(
        // `parentId` is dropped: parents are attached through the student surface, which applies the
        // tutor parent-sharing policy (`findParentForActor`).
        { ...createUserDto, role: 'STUDENT', tutorId: actor.id, parentId: undefined },
        { sendCredentials: true },
      );
    }
    throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  /**
   * `emailVerified` is an internal option (not a DTO field): only the OAuth sign-up path sets it,
   * because the provider has already proven ownership of the email.
   */
  async createUserService(
    createUserDto: CreateUserInput,
    {
      emailVerified = false,
      sendCredentials = false,
    }: { emailVerified?: boolean; sendCredentials?: boolean } = {},
  ): Promise<CreateUserResponseDto> {
    const { firstName, lastName, password, username } = createUserDto;
    const email = normalizeEmail(createUserDto.email);
    let resolvedUsername = username?.trim();

    const [existingByEmail, existingByUsername] = await Promise.all([
      this.getUserByField({ field: 'email', value: email }),
      resolvedUsername && this.getUserByField({ field: 'username', value: resolvedUsername }),
    ]);

    if (existingByEmail.length > 0) {
      this.logger.warn(`Status: 400 - Email already exists: ${email}`);
      throw new BadRequestException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }
    if (Array.isArray(existingByUsername) && existingByUsername.length > 0) {
      this.logger.warn(`Status: 400 - Username already exists: ${resolvedUsername}`);
      throw new BadRequestException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
    }

    const id = randomUUID();
    // Optional links must point at an existing account of the right role (never at a bad FK).
    if (createUserDto.parentId) await this.assertLinkTarget(id, createUserDto.parentId, 'PARENT');
    if (createUserDto.tutorId) await this.assertLinkTarget(id, createUserDto.tutorId, 'TUTOR');
    const plainPassword = password ?? generateRandomPassword();
    const hashedPassword = await hashData(plainPassword);
    const role = createUserDto.role ?? 'STUDENT';
    let userCode: string | undefined;
    if (role === 'TUTOR') {
      // Only a code proven free is used. If none is found, fail the create instead of writing a
      // code that may already exist (that would surface as a misleading "account exists" 409).
      for (let i = 0; i < 10 && !userCode; i++) {
        const candidate = generateUserCode();
        if (!(await this.userRepo.findUserCode(candidate))) userCode = candidate;
      }
      if (!userCode) throw new BadRequestException(ERROR_MESSAGES.FAILED_TO_CREATE_USER);
    }

    if (!username) {
      resolvedUsername = await this.generateUsername(firstName, lastName);
    }

    try {
      const user = await this.userRepo.create({
        id,
        ...(userCode ? { userCode } : {}),
        ...providedCreateFields(createUserDto),
        ...(createUserDto.parentId ? { parentId: createUserDto.parentId } : {}),
        ...(createUserDto.tutorId ? { tutorId: createUserDto.tutorId } : {}),
        email,
        username: resolvedUsername!,
        firstName,
        lastName,
        password: hashedPassword,
        role,
        emailVerified,
        // Staff-created STUDENT/TUTOR accounts must choose their own password at first sign-in.
        mustChangePassword: sendCredentials && (role === 'STUDENT' || role === 'TUTOR'),
      });

      // Staff-created accounts get their login credentials by mail; self sign-up/OAuth do not.
      if (sendCredentials) {
        await sendAccountCreatedMail(this.rmqProducer, {
          userId: user.id,
          email,
          username: resolvedUsername!,
          displayName: firstName,
          password: plainPassword,
        });
      }

      return { message: 'User created successfully', data: omitPassword(user) };
    } catch (error) {
      // A concurrent create can pass the pre-check above and then hit the unique index.
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new ConflictException(ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  /** Marks the account's email as proven-owned (verify-email, OAuth, reset-password flows). */
  async setEmailVerifiedService({ id, emailVerified }: { id: string; emailVerified: boolean }) {
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const updated = await this.userRepo.update(id, { emailVerified });
    if (!updated) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    return omitPassword(updated);
  }

  /**
   * Password write used by the change-password and reset-password flows. Every live login session
   * of the user is revoked afterwards (all devices), so refresh tokens and access stop working.
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
    // Revoke first (same order as changePasswordService): if Redis fails the password stays as it was,
    // never changed while old sessions are still alive.
    await this.revokeAllSessions(id);
    const updated = await this.userRepo.updatePassword(id, hashedPassword);
    return updated && omitPassword(updated);
  }

  /**
   * Admin-only write (`PUT /user/updateUserByAdmin/:id`, `user.updateUserByAdmin`). `expectedRole` lets the
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
    // An admin must not demote or deactivate their own account (the last-admin check cannot catch it).
    if (
      actor.id === id &&
      (data.isActive === false || (data.role !== undefined && data.role !== 'ADMIN'))
    )
      throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
    return this.applyUserUpdate({ id, data, expectedRole });
  }

  /**
   * Self-update (`PUT /user/updateUser`) or admin edit of a user through the student surface
   * (`PUT /student/update/:id`). Only the target themself or an ADMIN may call it. A STUDENT may not
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
    // Email: ADMIN/TUTOR/PARENT may change their own; a STUDENT may not (only an admin can).
    if (actor.id === id && actor.role === 'STUDENT' && data.email !== undefined) {
      throw new BadRequestException(ERROR_MESSAGES.STUDENT_CANNOT_UPDATE_EMAIL);
    }

    // Changing your own email changes who can reset your password, so it needs the current password
    // (a stolen access token alone is not enough). An admin editing someone else is not asked.
    if (actor.id === id && data.email !== undefined) {
      const current = await this.userRepo.findById(id);
      if (current && normalizeEmail(data.email) !== current.email) {
        const account = await this.userRepo.findWithPassword(id);
        if (account) await this.assertCurrentPassword(id, data.currentPassword, account.password);
      }
    }

    return this.applyUserUpdate({ id, data });
  }

  /**
   * Sets `isActive` to the requested value (ADMIN only). Idempotent: asking for the state the user
   * already has changes nothing. Deactivating revokes every session of the user.
   */
  async updateStatusUserService({
    id,
    isActive,
    actor,
  }: {
    id: string;
    isActive: boolean;
    actor: UserActor;
  }) {
    this.assertAdmin(actor);
    if (!id || !checkUuidValid({ data: id }))
      throw new BadRequestException(ERROR_MESSAGES.USER_ID_MUST_BE_UUID);

    const user = await this.userRepo.findById(id);
    if (!user) {
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    if (user.isActive === isActive) {
      // Idempotent, but a deactivation whose revoke failed earlier must still be able to finish:
      // the account is already inactive, so a plain retry would otherwise leave its sessions alive.
      if (!isActive) await this.revokeAllSessions(id);
      return omitPassword(user);
    }
    if (actor.id === id) {
      throw new ConflictException(ERROR_MESSAGES.CANNOT_MODIFY_OWN_STATUS);
    }

    if (!isActive) await this.assertNotLastActiveAdmin(user);

    const updated = await this.userRepo.update(id, { isActive });
    if (!isActive) await this.revokeAllSessions(id);
    return updated && omitPassword(updated);
  }

  /** Admin-only delete. Refuses the last active admin, self, and accounts still linked to it. */
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
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    if (actor.id === id) {
      throw new ConflictException(ERROR_MESSAGES.CANNOT_MODIFY_OWN_STATUS);
    }
    await this.assertNotLastActiveAdmin(user);
    // The FKs `users.tutor_id` / `users.parent_id` cascade on delete: deleting a tutor or parent
    // would silently delete every student linked to them. Refuse until those links are moved.
    await this.assertNoLinkedAccounts(id);

    await this.userRepo.delete(id);
    await this.revokeAllSessions(id);
    return { id };
  }

  /**
   * Changes the caller's password. Every other device is signed out, and the current device (`sid`)
   * stays signed in: its session is re-created and it gets a new refresh token. The refresh token
   * is returned only so the gateway can store it in the httpOnly cookie. It is not a body field.
   */
  async changePasswordService(userId: string, dto: ChangePasswordValues, sid: string) {
    if (!checkUuidValid({ data: sid })) {
      throw new BadRequestException(ERROR_MESSAGES.INVALID_SESSION);
    }
    const user = await this.userRepo.findWithPassword(userId);
    if (!user) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    await this.assertCurrentPassword(userId, dto.currentPassword, user.password);
    if (await compareData(dto.newPassword, user.password)) {
      throw new HttpException(
        ERROR_MESSAGES.NEW_PASSWORD_MUST_DIFFER,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const [fresh] = await this.getUserByField({ field: 'id', value: userId });
    if (!fresh) {
      throw new BadRequestException(ERROR_MESSAGES.USER_NOT_FOUND);
    }
    const hashedPassword = await hashData(dto.newPassword);

    // Order matters. Sessions are revoked first, so a Redis failure here leaves the password
    // unchanged and the old sessions as they were. Writing the password first could leave it
    // changed while the old sessions (possibly an attacker's) stay alive.
    // Revoke ends every session, the current device included; it is re-created just below.
    await this.revokeAllSessions(userId);
    await this.userRepo.updatePassword(userId, hashedPassword);

    const jwtTokensConfig = getJwtTokensConfig(this.configService);
    const refreshToken = await signRefreshToken(
      this.jwtService,
      { sub: userId, email: fresh.email, sid },
      jwtTokensConfig,
    );
    const ttlSeconds = jwtTokensConfig.refreshExpiresIn;
    try {
      await this.rmqProducer.send('redis.set', {
        key: sessionRedisKey(userId, sid),
        value: '1',
        ttlSeconds,
      });
      await this.rmqProducer.send('redis.set', {
        key: refreshHashRedisKey(userId, sid),
        value: hashRefreshToken(refreshToken),
        ttlSeconds,
      });
    } catch (error) {
      // The password is already changed: say so, so the user does not retry it with the old one.
      this.logger.warn('Session re-create failed after a password change', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.PASSWORD_CHANGED_SIGN_IN_AGAIN);
    }

    return { message: 'Password changed successfully', refreshToken };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Checks the password the caller typed as "current password". Wrong answers are counted per
   * account (a stolen access token must not be able to guess the password here), and the counter is
   * cleared by a right answer. 400 (not 401): the session is valid, only the submitted current
   * password is wrong — a 401 would make clients treat the access token as expired.
   */
  private async assertCurrentPassword(
    userId: string,
    password: string | undefined,
    hash: string,
  ): Promise<void> {
    let attempts: number;
    try {
      const reply = await this.rmqProducer.send<
        { count: number } | undefined,
        { key: string; windowSeconds: number }
      >(
        'redis.incr',
        {
          key: currentPasswordAttemptsRedisKey(userId),
          windowSeconds: CURRENT_PASSWORD_WINDOW_SECONDS,
        },
        2_000,
        0,
      );
      // An empty reply is unknown, not zero: fail closed rather than let the attempt through.
      if (!reply) throw new Error('empty redis.incr reply');
      attempts = reply.count ?? 0;
    } catch (error) {
      this.logger.warn('Current-password attempt counter unavailable', error);
      throw new ServiceUnavailableException(ERROR_MESSAGES.SECURITY_CHECK_UNAVAILABLE);
    }
    if (attempts > CURRENT_PASSWORD_MAX_ATTEMPTS) {
      throw new HttpException(
        ERROR_MESSAGES.CURRENT_PASSWORD_TOO_MANY_ATTEMPTS,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!password || !(await compareData(password, hash))) {
      throw new BadRequestException(ERROR_MESSAGES.CURRENT_PASSWORD_INCORRECT);
    }
    // Best effort: a missed delete only leaves the counter to expire on its own.
    void Promise.resolve(
      this.rmqProducer.emit('redis.del', { keys: [currentPasswordAttemptsRedisKey(userId)] }),
    ).catch((error: unknown) => this.logger.warn('Failed to clear password attempts', error));
  }

  private assertAdmin(actor: UserActor): void {
    if (actor.role !== 'ADMIN') throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  private assertSelfOrAdmin(actor: UserActor, targetId: string): void {
    if (actor.role === 'ADMIN') return;
    if (actor.id !== '' && actor.id === targetId) return;
    throw new ForbiddenException(ERROR_MESSAGES.FORBIDDEN_USER_ACTION);
  }

  /**
   * Revokes every login session of the user on every device: deletes all `session:{id}:*` and
   * `refresh:{id}:*` keys. Awaited and not swallowed: if revocation fails the caller must see it.
   */
  private async revokeAllSessions(userId: string): Promise<void> {
    await revokeAllUserSessions(this.rmqProducer, userId);
  }

  /** Refuses to deactivate, delete or demote the only active admin, which would lock everyone out. */
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

  /** Shared write behind every update path: uuid, existence, uniqueness, link and session checks. */
  private async applyUserUpdate({
    id,
    data: rawData,
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
      throw new NotFoundException(ERROR_MESSAGES.USER_NOT_FOUND);
    }

    const data: UpdateUserDto =
      rawData.email !== undefined ? { ...rawData, email: normalizeEmail(rawData.email) } : rawData;

    // Pre-check unique columns so a clash is a 409, not a raw Postgres 23505 → 500.
    if (data.email !== undefined && data.email !== user.email) {
      const taken = await this.getUserByField({ field: 'email', value: data.email });
      if (taken.length > 0) throw new ConflictException(ERROR_MESSAGES.EMAIL_EXISTS);
    }
    if (data.username !== undefined && data.username !== user.username) {
      const taken = await this.getUserByField({ field: 'username', value: data.username });
      if (taken.length > 0) throw new ConflictException(ERROR_MESSAGES.USERNAME_EXISTS);
    }
    // `users.userCode` has no unique index: two accounts sharing a code make code login ambiguous.
    if (data.userCode && data.userCode !== user.userCode) {
      const taken = await this.userRepo.findUserCode(data.userCode);
      if (taken && taken.id !== id) throw new ConflictException(ERROR_MESSAGES.STUDENT_CODE_EXISTS);
    }
    if (data.parentId) await this.assertLinkTarget(id, data.parentId, 'PARENT');
    if (data.tutorId) await this.assertLinkTarget(id, data.tutorId, 'TUTOR');

    // An admin losing the ADMIN role or being deactivated must not be the last one left.
    const demotes = data.role !== undefined && data.role !== user.role;
    const deactivates = data.isActive === false && user.isActive === true;
    // Revoke on every deactivation request, not only the first, so a retry after a failed revoke works.
    const revokesSessions = data.isActive === false;
    const emailChanged = data.email !== undefined && data.email !== user.email;
    if (user.role === 'ADMIN' && ((demotes && data.role !== 'ADMIN') || deactivates)) {
      await this.assertNotLastActiveAdmin(user);
    }

    // A new email address has not been proven yet, so it must be verified again.
    const updated = await this.userRepo.update(id, {
      ...sanitizeUpdate(data),
      ...(emailChanged ? { emailVerified: false } : {}),
    });

    // A role change or deactivation must not leave the old access alive for up to the token TTL.
    // A role/status change or a new email must not leave old sessions alive for up to the token TTL.
    if (demotes || revokesSessions || emailChanged) await this.revokeAllSessions(id);
    return updated && omitPassword(updated);
  }
}
