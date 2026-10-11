import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { UserRpcController } from 'src/features/user/user.rpc.controller';
import type { UserService } from 'src/features/user/user.service';

// user.service -> user.repository imports `@packages/database/schema`, which jest cannot resolve
// here. The RPC controller only needs the class token; every service method is mocked.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

describe('UserRpcController', () => {
  let controller: UserRpcController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      getUsersService: jest.fn(),
      getDetailUserService: jest.fn(),
      findUsersByFieldPublic: jest.fn(),
      createUserService: jest.fn(),
      updateOwnProfileService: jest.fn(),
      updateUserService: jest.fn(),
      updateStatusUserService: jest.fn(),
      deleteUserByAdminService: jest.fn(),
      changePasswordService: jest.fn(),
    };
    controller = new UserRpcController(service as unknown as UserService);
  });

  it.each([
    ['user.getUsers', 'getUsers', 'getUsersService', { page: 1 }, [{ page: 1 }]],
    [
      'user.getDetailUser',
      'getDetailUser',
      'getDetailUserService',
      { userId: 'u1' },
      [{ id: 'u1' }],
    ],
    [
      'user.getUserByField',
      'getUserByField',
      'findUsersByFieldPublic',
      { field: 'email', value: 'a' },
      [{ field: 'email', value: 'a' }],
    ],
    ['user.createUser', 'createUser', 'createUserService', { email: 'a' }, [{ email: 'a' }]],
    [
      'user.updateUserByAdmin',
      'updateUserByAdmin',
      'updateUserService',
      { id: 'u1', firstName: 'X' },
      [{ id: 'u1', data: { firstName: 'X' } }],
    ],
    [
      'user.updateStatusUser',
      'updateStatusUser',
      'updateStatusUserService',
      { id: 'u1' },
      [{ id: 'u1' }],
    ],
    [
      'user.deleteUserByAdmin',
      'deleteUserByAdmin',
      'deleteUserByAdminService',
      { id: 'u1' },
      [{ id: 'u1' }],
    ],
  ])(
    '%s -> %s delegates to UserService.%s',
    async (pattern, method, svc, payload, expectedArgs) => {
      const sentinel = { ok: svc };
      service[svc].mockResolvedValue(sentinel);
      const handler = (controller as unknown as Record<string, (p: unknown) => Promise<unknown>>)[
        method
      ];

      await expect(handler.call(controller, payload)).resolves.toBe(sentinel);

      expect(Reflect.getMetadata(PATTERN_METADATA, handler)).toEqual([pattern]);
      expect(service[svc]).toHaveBeenCalledWith(...expectedArgs);
    },
  );

  it('user.updateUser passes the caller role from the payload into the self-update guard', async () => {
    controller.updateUser({ userId: 'u1', role: 'STUDENT', firstName: 'Ann' } as never);

    expect(service.updateOwnProfileService).toHaveBeenCalledWith({
      id: 'u1',
      role: 'STUDENT',
      data: { firstName: 'Ann' },
    });
  });

  it('user.changePassword splits userId from the password fields', async () => {
    controller.changePassword({ userId: 'u1', currentPassword: 'a', newPassword: 'b' } as never);

    expect(service.changePasswordService).toHaveBeenCalledWith('u1', {
      currentPassword: 'a',
      newPassword: 'b',
    });
  });

  it('surfaces service rejections to the RPC caller', async () => {
    service.deleteUserByAdminService.mockRejectedValue(new Error('USER_NOT_FOUND'));

    await expect(controller.deleteUserByAdmin({ id: 'missing' })).rejects.toThrow('USER_NOT_FOUND');
  });
});
