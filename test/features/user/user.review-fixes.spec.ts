import { ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_MESSAGES } from 'src/data/constants';
import { UserService } from 'src/features/user/user.service';
import type { UserRepository } from 'src/features/user/user.repository';

jest.mock('src/features/user/user.repository', () => ({ UserRepository: class UserRepository {} }));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const OTHER_ID = '0b9e7d1a-2c3f-4a5b-9c8d-7e6f5a4b3c2d';
const TUTOR_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
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
    userCode: null,
    password: 'hash',
    ...overrides,
  };
}

describe('UserService review fixes', () => {
  let service: UserService;
  let repo: Record<string, jest.Mock>;
  let rmq: { send: jest.Mock; emit: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findByField: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(row()),
      findUserCode: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(async (data: Record<string, unknown>) => ({ ...data })),
      update: jest.fn(async (_id: string, data: Record<string, unknown>) => row(data)),
      countActiveAdmins: jest.fn().mockResolvedValue(2),
    };
    rmq = { send: jest.fn().mockResolvedValue({ deleted: 0 }), emit: jest.fn() };
    const secrets: Record<string, string> = {
      JWT_ACCESS_SECRET: 'access-test-secret',
      JWT_REFRESH_SECRET: 'refresh-test-secret',
    };
    service = new UserService(repo as unknown as UserRepository, rmq as never, new JwtService({}), {
      get: (key: string) => secrets[key],
    } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const revokedPatterns = () => rmq.send.mock.calls.map((c) => c[0]);

  describe('deactivation is retry-safe', () => {
    it('revokes sessions again when the account is already inactive', async () => {
      repo.findById.mockResolvedValue(row({ isActive: false }));
      await service.updateStatusUserService({ id: USER_ID, isActive: false, actor: ADMIN_ACTOR });
      expect(repo.update).not.toHaveBeenCalled();
      expect(revokedPatterns()).toContain('redis.delByPrefix');
    });

    it('does not revoke when asked to keep an active account active', async () => {
      await service.updateStatusUserService({ id: USER_ID, isActive: true, actor: ADMIN_ACTOR });
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('revokes on a repeated isActive=false through the generic update', async () => {
      repo.findById.mockResolvedValue(row({ isActive: false }));
      await service.updateUserService({
        actor: ADMIN_ACTOR,
        id: USER_ID,
        data: { isActive: false } as never,
      });
      expect(revokedPatterns()).toContain('redis.delByPrefix');
    });
  });

  describe('createUserByActorService', () => {
    it('links a student created by a TUTOR to that tutor', async () => {
      repo.findById.mockResolvedValue(row({ id: TUTOR_ID, role: 'TUTOR' }));
      await service.createUserByActorService(
        { email: 'S@Example.com', password: 'Abcdef1!', firstName: 'A', lastName: 'B', role: 'ADMIN' } as never,
        { id: TUTOR_ID, role: 'TUTOR' },
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'STUDENT', tutorId: TUTOR_ID }),
      );
    });

    it('keeps parentId and refuses one that is not a PARENT account', async () => {
      repo.findById.mockResolvedValue(row({ id: OTHER_ID, role: 'TUTOR' }));
      await expect(
        service.createUserByActorService(
          { email: 's@example.com', password: 'Abcdef1!', firstName: 'A', lastName: 'B', parentId: OTHER_ID } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.INVALID_LINK_TARGET });
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('userCode uniqueness on update', () => {
    it('rejects a userCode already held by another account', async () => {
      repo.findUserCode.mockResolvedValue({ id: OTHER_ID });
      await expect(
        service.updateUserService({ actor: ADMIN_ACTOR, id: USER_ID, data: { userCode: 'ABC123' } as never }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows re-saving the account\'s own userCode', async () => {
      repo.findById.mockResolvedValue(row({ userCode: 'OLD111' }));
      repo.findUserCode.mockResolvedValue({ id: USER_ID });
      await service.updateUserService({ actor: ADMIN_ACTOR, id: USER_ID, data: { userCode: 'ABC123' } as never });
      expect(repo.update).toHaveBeenCalled();
    });
  });
});
