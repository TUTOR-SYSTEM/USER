import {
  BadRequestException,
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { compareData, hashData } from '@packages/helpers';
import { ERROR_MESSAGES } from 'src/data/constants';
import { UserService } from 'src/features/user/user.service';
import type { UserRepository } from 'src/features/user/user.repository';

// user.repository imports `@packages/database/schema`, which the jest moduleNameMapper cannot
// resolve. The service only needs the class token, so the repository module is stubbed.
jest.mock('src/features/user/user.repository', () => ({ UserRepository: class UserRepository {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const OTHER_ID = '0b9e7d1a-2c3f-4a5b-9c8d-7e6f5a4b3c2d';
const ADMIN_ACTOR = { id: OTHER_ID, role: 'ADMIN' };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'user@example.test',
    username: 'userone',
    firstName: 'Ann',
    lastName: 'Le',
    role: 'STUDENT',
    isActive: true,
    password: 'hash',
    ...overrides,
  };
}

describe('UserService', () => {
  let service: UserService;
  let repo: Record<string, jest.Mock>;
  let rmq: { send: jest.Mock; emit: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findByField: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(row()),
      findWithPassword: jest.fn().mockResolvedValue(undefined),
      findUserCode: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(async (data: Record<string, unknown>) => ({
        ...data,
        firstName: data.firstName,
        lastName: data.lastName,
      })),
      update: jest.fn().mockResolvedValue(undefined),
      updatePassword: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      buildUserListConditions: jest.fn().mockReturnValue(undefined),
      countUsers: jest.fn().mockResolvedValue(0),
      paginateUsers: jest.fn().mockResolvedValue([]),
      countLinkedUsers: jest.fn().mockResolvedValue(0),
      countActiveAdmins: jest.fn().mockResolvedValue(2),
    };
    rmq = {
      send: jest.fn().mockResolvedValue({ deleted: 0 }),
      emit: jest.fn().mockResolvedValue(undefined),
    };
    service = new UserService(repo as unknown as UserRepository, rmq as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getUserByField', () => {
    it('rejects a field outside the searchable whitelist before touching the database', async () => {
      await expect(
        service.getUserByField({ field: 'password', value: 'x' } as never),
      ).rejects.toMatchObject({ message: `${ERROR_MESSAGES.UNSUPPORTED_FIELD}: password` });
      expect(repo.findByField).not.toHaveBeenCalled();
    });

    it.each(['email', 'username', 'phone', 'userCode'])('searches by %s', async (field) => {
      await service.getUserByField({ field, value: 'v' } as never);
      expect(repo.findByField).toHaveBeenCalledWith(field, 'v');
    });

    it('searches by id when the value is a uuid', async () => {
      await service.getUserByField({ field: 'id', value: USER_ID } as never);
      expect(repo.findByField).toHaveBeenCalledWith('id', USER_ID);
    });

    it('lowercases and trims an email before searching', async () => {
      await service.getUserByField({ field: 'email', value: '  Mixed@Example.TEST ' } as never);
      expect(repo.findByField).toHaveBeenCalledWith('email', 'mixed@example.test');
    });

    it('defaults a null role to STUDENT', async () => {
      repo.findByField.mockResolvedValue([row({ role: null })]);

      const [user] = await service.getUserByField({ field: 'id', value: USER_ID } as never);

      expect(user.role).toBe('STUDENT');
    });
  });

  describe('getDetailUserService', () => {
    it('rejects a non-UUID id', async () => {
      await expect(
        service.getDetailUserService({ actor: ADMIN_ACTOR, id: 'nope' }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_ID_MUST_BE_UUID,
      });
    });

    it('returns NotFound (not a 200 with null) when the user does not exist', async () => {
      repo.findById.mockResolvedValue(undefined);
      await expect(
        service.getDetailUserService({ actor: ADMIN_ACTOR, id: USER_ID }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_NOT_FOUND });
    });

    it('returns the profile without the password hash', async () => {
      repo.findById.mockResolvedValue(row());

      const user = await service.getDetailUserService({ actor: ADMIN_ACTOR, id: USER_ID });

      expect(user).not.toHaveProperty('password');
      expect(user).toMatchObject({ id: USER_ID, email: 'user@example.test' });
    });
  });

  describe('getUsersService', () => {
    it.each([
      [0, 10, 0],
      [25, 10, 3],
      [10, 10, 1],
    ])('computes totalPages for total=%i limit=%i', async (total, limit, pages) => {
      repo.countUsers.mockResolvedValue(total);
      repo.paginateUsers.mockResolvedValue([]);

      const result = await service.getUsersService({ page: 1, limit } as never, ADMIN_ACTOR);

      expect(result.pagination).toEqual({ page: 1, limit, total, totalPages: pages });
    });

    it('maps rows to the list shape and computes the offset from page/limit', async () => {
      repo.countUsers.mockResolvedValue(1);
      repo.paginateUsers.mockResolvedValue([
        { ...row({ role: null, isActive: false }), createdAt: new Date('2026-01-02T00:00:00Z') },
      ]);

      const result = await service.getUsersService({ page: 3, limit: 5 } as never, ADMIN_ACTOR);

      expect(repo.paginateUsers).toHaveBeenCalledWith(undefined, 5, 10);
      expect(result.users[0]).toEqual({
        id: USER_ID,
        email: 'user@example.test',
        firstName: 'Ann',
        lastName: 'Le',
        phone: null,
        avatar: null,
        role: 'STUDENT',
        isActive: false,
        createdAt: '2026-01-02T00:00:00.000Z',
      });
    });
  });

  describe('createUserService', () => {
    const base = {
      email: 'new@example.test',
      password: 'Plain-1',
      firstName: 'Bao',
      lastName: 'Tran',
    };

    it('rejects an email that already exists', async () => {
      repo.findByField.mockResolvedValueOnce([row()]);

      await expect(
        service.createUserService({ ...base, username: 'x' } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a username that already exists', async () => {
      repo.findByField.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);

      await expect(
        service.createUserService({ ...base, username: 'taken' } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS,
      });
    });

    it('stores a bcrypt hash, never the plain password, and defaults the role to STUDENT', async () => {
      await service.createUserService({ ...base, username: 'bao' } as never);

      const saved = repo.create.mock.calls[0][0] as {
        password: string;
        role: string;
        userCode?: string;
      };
      expect(saved.password).not.toBe(base.password);
      await expect(compareData(base.password, saved.password)).resolves.toBe(true);
      expect(saved.role).toBe('STUDENT');
      expect(saved.userCode).toBeUndefined();
    });

    it('assigns a 6-character userCode to TUTOR accounts', async () => {
      await service.createUserService({ ...base, username: 'tutor1', role: 'TUTOR' } as never);

      const saved = repo.create.mock.calls[0][0] as { userCode: string; role: string };
      expect(saved.role).toBe('TUTOR');
      expect(saved.userCode).toMatch(/^[0-9A-F]{6}$/);
    });

    it('generates a username from the name when none is given', async () => {
      await service.createUserService({ ...base } as never);

      const saved = repo.create.mock.calls[0][0] as { username: string };
      expect(saved.username).toBe('tranbao');
    });
  });

  describe('generateUsername', () => {
    it('strips accents and spaces from the base candidate', async () => {
      await expect(service.generateUsername('Bảo', 'Nguyễn Văn')).resolves.toBe('nguyenvanbao');
    });

    it('appends a numeric suffix while candidates are taken', async () => {
      repo.findByField
        .mockResolvedValueOnce([row()])
        .mockResolvedValueOnce([row()])
        .mockResolvedValue([]);

      await expect(service.generateUsername('Ann', 'Le')).resolves.toBe('leann2');
    });

    it('throws a conflict after 10 taken candidates', async () => {
      repo.findByField.mockResolvedValue([row()]);

      await expect(service.generateUsername('Ann', 'Le')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updateUserService', () => {
    it('rejects a non-UUID id', async () => {
      await expect(
        service.updateUserService({ actor: ADMIN_ACTOR, id: 'x', data: {} as never }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_ID_MUST_BE_UUID,
      });
    });

    it('rejects an unknown user', async () => {
      repo.findById.mockResolvedValue(undefined);
      await expect(
        service.updateUserService({ actor: ADMIN_ACTOR, id: USER_ID, data: {} as never }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_NOT_FOUND,
      });
    });

    it('rejects changing the email to one another account already uses', async () => {
      repo.findByField
        .mockResolvedValueOnce([row()]) // load target
        .mockResolvedValueOnce([row({ id: OTHER_ID, email: 'taken@example.test' })]); // email taken

      await expect(
        service.updateUserService({
          actor: ADMIN_ACTOR,
          id: USER_ID,
          data: { email: 'taken@example.test' } as never,
        }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.EMAIL_EXISTS });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns the updated row without its password', async () => {
      repo.findByField.mockResolvedValueOnce([row()]);
      repo.update.mockResolvedValue(row({ firstName: 'Changed' }));

      const result = await service.updateUserService({
        actor: ADMIN_ACTOR,
        id: USER_ID,
        data: { firstName: 'Changed' } as never,
      });

      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({ firstName: 'Changed' });
    });
  });

  describe('uncovered service branches', () => {
    it('findUsersByFieldPublic returns the lookup result with the password stripped', async () => {
      repo.findByField.mockResolvedValue([row()]);

      const result = await service.findUsersByFieldPublic(
        {
          field: 'email',
          value: 'user@example.test',
        } as never,
        ADMIN_ACTOR,
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: USER_ID, email: 'user@example.test' });
      expect(result[0]).not.toHaveProperty('password');
    });

    it('createUserService regenerates a TUTOR userCode that collides once, then keeps the free one', async () => {
      repo.findUserCode.mockResolvedValueOnce({ id: OTHER_ID }).mockResolvedValueOnce(undefined);

      await service.createUserService({
        email: 'tutor@example.test',
        firstName: 'Ann',
        lastName: 'Le',
        password: 'Abcdef1!',
        username: 'tutorann',
        role: 'TUTOR',
      } as never);

      expect(repo.findUserCode).toHaveBeenCalledTimes(2);
      const saved = repo.create.mock.calls[0][0] as { userCode: string };
      expect(saved.userCode).toMatch(/^[0-9A-F]{6}$/);
    });

    it('updateUserPasswordService rejects an id that does not match any user', async () => {
      await expect(
        service.updateUserPasswordService({ id: USER_ID, password: 'Abcdef1!' }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_NOT_FOUND });
      expect(repo.updatePassword).not.toHaveBeenCalled();
    });

    it.each([
      [
        'updateUserPasswordService',
        (svc: UserService) =>
          svc.updateUserPasswordService({ id: 'not-a-uuid', password: 'Abcdef1!' }),
      ],
      [
        'updateStatusUserService',
        (svc: UserService) =>
          svc.updateStatusUserService({ id: 'not-a-uuid', isActive: false, actor: ADMIN_ACTOR }),
      ],
      [
        'deleteUserByAdminService',
        (svc: UserService) =>
          svc.deleteUserByAdminService({ id: 'not-a-uuid', actor: ADMIN_ACTOR }),
      ],
    ])('%s rejects a malformed id before touching the database', async (_name, call) => {
      await expect(call(service)).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_ID_MUST_BE_UUID,
      });
      expect(repo.findByField).not.toHaveBeenCalled();
    });

    it('updateUserService rejects a username already held by another account', async () => {
      repo.findByField
        .mockResolvedValueOnce([row()])
        .mockResolvedValueOnce([row({ id: OTHER_ID, username: 'taken' })]);

      await expect(
        service.updateUserService({
          actor: ADMIN_ACTOR,
          id: USER_ID,
          data: { username: 'taken' } as never,
        }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USERNAME_EXISTS });
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('getUsersService active status', () => {
    it('reports an active user as active', async () => {
      repo.countUsers.mockResolvedValue(1);
      repo.paginateUsers.mockResolvedValue([
        { ...row({ isActive: true }), createdAt: new Date('2026-01-02T00:00:00Z') },
      ]);

      const result = await service.getUsersService({ page: 1, limit: 10 } as never, ADMIN_ACTOR);

      expect(result.users[0]).toMatchObject({ isActive: true });
    });
  });

  describe('getUsersService row mapping', () => {
    it('defaults a missing role to STUDENT, marks non-true isActive as inactive, and stringifies string timestamps', async () => {
      repo.countUsers.mockResolvedValue(1);
      repo.paginateUsers.mockResolvedValue([
        { ...row({ role: undefined, isActive: null }), createdAt: '2026-01-02' },
      ]);

      const result = await service.getUsersService({ page: 1, limit: 10 } as never, ADMIN_ACTOR);

      expect(result.users[0]).toMatchObject({
        role: 'STUDENT',
        isActive: false,
        createdAt: '2026-01-02',
      });
    });
  });

  describe('updateOwnProfileService (self-update restrictions)', () => {
    beforeEach(() => {
      repo.findByField.mockResolvedValue([row()]);
      repo.update.mockResolvedValue(row());
    });

    it.each(['role', 'isActive', 'userCode', 'parentId', 'tutorId'])(
      'blocks a self-update that touches the admin-only field "%s"',
      async (field) => {
        await expect(
          service.updateOwnProfileService({
            actor: { id: USER_ID, role: 'TUTOR' },
            id: USER_ID,
            data: { [field]: 'x' } as never,
          }),
        ).rejects.toMatchObject({ message: ERROR_MESSAGES.CANNOT_UPDATE_RESTRICTED_FIELDS });
        expect(repo.update).not.toHaveBeenCalled();
      },
    );

    it.each(['firstName', 'lastName'])('blocks a STUDENT from renaming via "%s"', async (field) => {
      await expect(
        service.updateOwnProfileService({
          actor: { id: USER_ID, role: 'STUDENT' },
          id: USER_ID,
          data: { [field]: 'New' } as never,
        }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.STUDENT_CANNOT_UPDATE_NAME });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows a TUTOR to rename themselves', async () => {
      await service.updateOwnProfileService({
        actor: { id: USER_ID, role: 'TUTOR' },
        id: USER_ID,
        data: { firstName: 'New' } as never,
      });

      expect(repo.update).toHaveBeenCalledWith(USER_ID, { firstName: 'New' });
    });
  });

  describe('updateStatusUserService', () => {
    it('writes the requested isActive value and revokes every session on deactivation', async () => {
      repo.findById.mockResolvedValue(row({ isActive: true }));
      repo.update.mockResolvedValue(row({ isActive: false }));

      await service.updateStatusUserService({ actor: ADMIN_ACTOR, id: USER_ID, isActive: false });

      expect(repo.update).toHaveBeenCalledWith(USER_ID, { isActive: false });
      expect(rmq.send).toHaveBeenCalledWith('redis.delByPrefix', {
        prefix: `session:${USER_ID}:`,
      });
    });

    it('is idempotent: asking for the state the user already has writes nothing', async () => {
      repo.findById.mockResolvedValue(row({ isActive: true }));

      await service.updateStatusUserService({ actor: ADMIN_ACTOR, id: USER_ID, isActive: true });

      expect(repo.update).not.toHaveBeenCalled();
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('rejects an unknown user', async () => {
      repo.findById.mockResolvedValue(undefined);
      await expect(
        service.updateStatusUserService({ actor: ADMIN_ACTOR, id: USER_ID, isActive: false }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_NOT_FOUND,
      });
    });
  });

  describe('deleteUserByAdminService', () => {
    it('deletes an existing user and returns the id', async () => {
      repo.findByField.mockResolvedValueOnce([row()]);

      await expect(
        service.deleteUserByAdminService({ actor: ADMIN_ACTOR, id: USER_ID }),
      ).resolves.toEqual({
        id: USER_ID,
      });
      expect(repo.delete).toHaveBeenCalledWith(USER_ID);
    });

    it('does not delete when the user is missing', async () => {
      repo.findById.mockResolvedValue(undefined);
      await expect(
        service.deleteUserByAdminService({ actor: ADMIN_ACTOR, id: USER_ID }),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.USER_NOT_FOUND,
      });
      expect(repo.delete).not.toHaveBeenCalled();
    });
  });

  describe('changePasswordService', () => {
    it('rejects when the account is missing', async () => {
      await expect(
        service.changePasswordService(USER_ID, { currentPassword: 'a', newPassword: 'b' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a wrong current password and does not change anything', async () => {
      repo.findWithPassword.mockResolvedValue({ password: await hashData('real-old') });

      await expect(
        service.changePasswordService(USER_ID, {
          currentPassword: 'guess',
          newPassword: 'New-1',
        } as never),
      ).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: ERROR_MESSAGES.CURRENT_PASSWORD_INCORRECT,
      });
      expect(repo.updatePassword).not.toHaveBeenCalled();
    });

    it('stores a new hash of the new password when the current one matches', async () => {
      repo.findWithPassword.mockResolvedValue({ password: await hashData('real-old') });
      repo.findByField.mockResolvedValue([row()]);
      repo.updatePassword.mockResolvedValue(row());

      await expect(
        service.changePasswordService(USER_ID, {
          currentPassword: 'real-old',
          newPassword: 'New-1',
        } as never),
      ).resolves.toEqual({ message: 'Password changed successfully' });

      const [, stored] = repo.updatePassword.mock.calls[0] as [string, string];
      expect(stored).not.toBe('New-1');
      await expect(compareData('New-1', stored)).resolves.toBe(true);
    });
  });
});
