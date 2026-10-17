import { BadRequestException, Logger } from '@nestjs/common';
import { ERROR_MESSAGES } from 'src/data/constants';
import { UserService, type UserActor } from 'src/features/user/user.service';
import type { UserRepository } from 'src/features/user/user.repository';
import type { RmqProducer } from 'src/features/rabbitmq/rmq.producer';
import { updateUserSchema } from '@packages/entities/user/user.schema';

// user.repository imports `@packages/database/schema`; the service only needs the class token.
jest.mock('src/features/user/user.repository', () => ({ UserRepository: class UserRepository {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const OTHER_ID = '0b9e7d1a-2c3f-4a5b-9c8d-7e6f5a4b3c2d';
const STUDENT: UserActor = { id: USER_ID, role: 'STUDENT' };
const ADMIN: UserActor = { id: OTHER_ID, role: 'ADMIN' };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'old@example.test',
    username: 'userone',
    firstName: 'Ann',
    lastName: 'Le',
    role: 'STUDENT',
    isActive: true,
    emailVerified: true,
    password: 'hash',
    ...overrides,
  };
}

describe('UserService email verification', () => {
  let service: UserService;
  let repo: Record<string, jest.Mock>;
  let rmq: { emit: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findByField: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(row()),
      findUserCode: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(async (data: Record<string, unknown>) => data),
      update: jest.fn(async (_id: string, data: Record<string, unknown>) => row(data)),
    };
    rmq = { emit: jest.fn().mockResolvedValue(undefined), send: jest.fn() };
    service = new UserService(repo as unknown as UserRepository, rmq as unknown as RmqProducer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createUserService emailVerified option', () => {
    const base = {
      email: 'new@example.test',
      password: 'Plain-1',
      firstName: 'Bao',
      lastName: 'Tran',
      username: 'bao',
    };

    it('creates the account unverified by default', async () => {
      await service.createUserService(base as never);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false }));
    });

    it('creates the account verified only when the internal option is passed (OAuth sign-up)', async () => {
      await service.createUserService(base as never, { emailVerified: true });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
    });

    it('ignores an emailVerified value smuggled in the DTO body', async () => {
      await service.createUserService({ ...base, emailVerified: true } as never);

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: false }));
    });
  });

  describe('setEmailVerifiedService', () => {
    it('writes emailVerified on the row and returns it without the password hash', async () => {
      const result = await service.setEmailVerifiedService({ id: USER_ID, emailVerified: true });

      expect(repo.update).toHaveBeenCalledWith(USER_ID, { emailVerified: true });
      expect(result).not.toHaveProperty('password');
      expect(result).toMatchObject({ id: USER_ID, emailVerified: true });
    });

    it('rejects a non-uuid id before touching the database', async () => {
      await expect(
        service.setEmailVerifiedService({ id: 'nope', emailVerified: true }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_ID_MUST_BE_UUID });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects when no row was updated (unknown user)', async () => {
      repo.update.mockResolvedValueOnce(null);

      await expect(
        service.setEmailVerifiedService({ id: USER_ID, emailVerified: true }),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.USER_NOT_FOUND });
    });
  });

  describe('self-update (PUT /users) cannot change the email', () => {
    it('rejects an email change with 400 CANNOT_UPDATE_RESTRICTED_FIELDS and writes nothing', async () => {
      const call = service.updateOwnProfileService({
        id: USER_ID,
        actor: STUDENT,
        data: { email: 'attacker-chosen@example.test' } as never,
      });

      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(call).rejects.toMatchObject({
        message: ERROR_MESSAGES.CANNOT_UPDATE_RESTRICTED_FIELDS,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('drops a client-supplied emailVerified from the write, keeping the other fields', async () => {
      await service.updateOwnProfileService({
        id: USER_ID,
        actor: STUDENT,
        data: { emailVerified: true, username: 'newname' } as never,
      });

      expect(repo.update).toHaveBeenCalledTimes(1);
      const [, patch] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch).not.toHaveProperty('emailVerified');
      expect(patch).toMatchObject({ username: 'newname' });
    });
  });

  describe('admin email change resets verification', () => {
    it('sets emailVerified=false when an admin changes the email', async () => {
      await service.updateUserService({
        id: USER_ID,
        actor: ADMIN,
        data: { email: 'new@example.test' } as never,
      });

      expect(repo.update).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ email: 'new@example.test', emailVerified: false }),
      );
    });

    it('cannot pre-verify the new address: a body emailVerified=true is overridden to false', async () => {
      await service.updateUserService({
        id: USER_ID,
        actor: ADMIN,
        data: { email: 'new@example.test', emailVerified: true } as never,
      });

      const [, patch] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.emailVerified).toBe(false);
    });

    it('leaves verification alone when the email is unchanged, and ignores a body emailVerified', async () => {
      await service.updateUserService({
        id: USER_ID,
        actor: ADMIN,
        data: { firstName: 'Changed', emailVerified: false } as never,
      });

      const [, patch] = repo.update.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch).not.toHaveProperty('emailVerified');
      expect(patch).toMatchObject({ firstName: 'Changed' });
    });
  });

  describe('updateUserSchema (request body)', () => {
    it('rejects a body carrying emailVerified (strict schema), so it never reaches the service', () => {
      // The schema is `.strict()`: an unknown key fails validation (422 via ZodValidationPipe)
      // rather than being silently dropped. Either way the value is never written.
      const result = updateUserSchema.safeParse({ emailVerified: true, firstName: 'Ann' });

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({ code: 'unrecognized_keys', keys: ['emailVerified'] }),
      ]);
    });

    it('still accepts email in the body, so the 400 comes from the service restriction', () => {
      expect(updateUserSchema.parse({ email: 'a@example.test' })).toEqual({
        email: 'a@example.test',
      });
    });
  });
});
