import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { UnprocessableEntityException } from '@nestjs/common';
import { UserRpcController } from 'src/features/user/user.rpc.controller';
import type { UserService } from 'src/features/user/user.service';

// user.service -> user.repository imports `@packages/database/schema`, which jest cannot resolve
// here. The RPC controller only needs the class token; every service method is mocked.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const ADMIN = { actorId: 'a1', actorRole: 'ADMIN' };
const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';

describe('UserRpcController', () => {
  let controller: UserRpcController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      getUsersService: jest.fn(),
      getDetailUserService: jest.fn(),
      findUsersByFieldPublic: jest.fn(),
      createUserByActorService: jest.fn(),
      updateOwnProfileService: jest.fn(),
      updateUserService: jest.fn(),
      updateStatusUserService: jest.fn(),
      deleteUserByAdminService: jest.fn(),
      changePasswordService: jest.fn(),
    };
    controller = new UserRpcController(service as unknown as UserService);
  });

  it.each([
    ['user.getUsers', 'getUsers', 'getUsersService'],
    ['user.getDetailUser', 'getDetailUser', 'getDetailUserService'],
    ['user.getUserByField', 'getUserByField', 'findUsersByFieldPublic'],
    ['user.createUser', 'createUser', 'createUserByActorService'],
    ['user.updateUser', 'updateUser', 'updateOwnProfileService'],
    ['user.updateUserByAdmin', 'updateUserByAdmin', 'updateUserService'],
    ['user.updateStatusUser', 'updateStatusUser', 'updateStatusUserService'],
    ['user.deleteUserByAdmin', 'deleteUserByAdmin', 'deleteUserByAdminService'],
    ['user.changePassword', 'changePassword', 'changePasswordService'],
  ])('%s is served by %s and delegates to UserService.%s', (pattern, method, svc) => {
    const handler = (controller as unknown as Record<string, unknown>)[method];
    expect(Reflect.getMetadata(PATTERN_METADATA, handler as object)).toEqual([pattern]);
    expect(service[svc]).toBeDefined();
  });

  it('getUsers validates the query and hands the forwarded actor to the service', async () => {
    service.getUsersService.mockResolvedValue({ users: [], pagination: {} });
    await controller.getUsers({ page: '2', limit: '5', ...ADMIN } as never);
    expect(service.getUsersService).toHaveBeenCalledWith(
      { page: 2, limit: 5 },
      { id: 'a1', role: 'ADMIN' },
    );
  });

  it('getDetailUser passes the target id, expectedRole and the caller', async () => {
    service.getDetailUserService.mockResolvedValue({ id: USER_ID });
    await controller.getDetailUser({ userId: USER_ID, expectedRole: 'STUDENT', ...ADMIN });
    expect(service.getDetailUserService).toHaveBeenCalledWith({
      id: USER_ID,
      actor: { id: 'a1', role: 'ADMIN' },
      expectedRole: 'STUDENT',
    });
  });

  it('createUser validates the payload and never passes actor fields into the data', async () => {
    service.createUserByActorService.mockResolvedValue({ message: 'ok' });
    await controller.createUser({
      email: 'New@Example.test',
      firstName: 'Ann',
      lastName: 'Le',
      password: 'Abcdef1!',
      role: 'TUTOR',
      ...ADMIN,
    } as never);
    const [dto, actor] = service.createUserByActorService.mock.calls[0];
    expect(dto).not.toHaveProperty('actorId');
    expect(dto).not.toHaveProperty('actorRole');
    expect(dto).toMatchObject({ email: 'New@Example.test', role: 'TUTOR' });
    expect(actor).toEqual({ id: 'a1', role: 'ADMIN' });
  });

  it('createUser rejects a weak password with 422 before reaching the service', async () => {
    await expect(
      controller.createUser({
        email: 'a@b.test',
        firstName: 'Ann',
        lastName: 'Le',
        password: 'short',
        ...ADMIN,
      } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(service.createUserByActorService).not.toHaveBeenCalled();
  });

  it('updateUser drops the role field and scopes the update to the caller', async () => {
    service.updateOwnProfileService.mockResolvedValue({});
    await controller.updateUser({
      userId: USER_ID,
      role: 'STUDENT',
      firstName: 'Ann',
      actorId: USER_ID,
      actorRole: 'STUDENT',
    } as never);
    expect(service.updateOwnProfileService).toHaveBeenCalledWith({
      id: USER_ID,
      actor: { id: USER_ID, role: 'STUDENT' },
      data: { firstName: 'Ann' },
    });
  });

  it('updateStatusUser takes an explicit isActive and rejects a non-boolean', async () => {
    service.updateStatusUserService.mockResolvedValue({});
    await controller.updateStatusUser({ id: USER_ID, isActive: false, ...ADMIN });
    expect(service.updateStatusUserService).toHaveBeenCalledWith({
      id: USER_ID,
      isActive: false,
      actor: { id: 'a1', role: 'ADMIN' },
    });
    await expect(
      controller.updateStatusUser({ id: USER_ID, isActive: 'no', ...ADMIN } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('changePassword splits userId from the password fields and validates them', async () => {
    service.changePasswordService.mockResolvedValue({ message: 'ok' });
    await controller.changePassword({
      userId: USER_ID,
      currentPassword: 'anything',
      newPassword: 'Abcdef1!',
    } as never);
    expect(service.changePasswordService).toHaveBeenCalledWith(USER_ID, {
      currentPassword: 'anything',
      newPassword: 'Abcdef1!',
    });
  });

  it('surfaces service rejections to the RPC caller', async () => {
    service.deleteUserByAdminService.mockRejectedValue(new Error('USER_NOT_FOUND'));
    await expect(controller.deleteUserByAdmin({ id: 'missing', ...ADMIN })).rejects.toThrow(
      'USER_NOT_FOUND',
    );
  });
});
