import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { UnprocessableEntityException } from '@nestjs/common';
import { UserRpcController } from 'src/features/user/user.rpc.controller';
import type { UserService } from 'src/features/user/user.service';
import { computeRpcActorSignature, RPC_ACTOR_MAX_AGE_MS } from '@packages/helpers';

// user.service -> user.repository imports `@packages/database/schema`, which jest cannot resolve
// here. The RPC controller only needs the class token; every service method is mocked.
jest.mock('src/features/user/user.service', () => ({ UserService: class UserService {} }));

const RPC_SECRET = 'test-rpc-actor-secret';
process.env.RPC_ACTOR_SECRET = RPC_SECRET;

/** Adds the gateway signature the way gateway's RmqProducer does, so the handler accepts the actor. */
function signed(actor: { actorId: string; actorRole: string; actorSid?: string }) {
  const actorSid = actor.actorSid ?? '';
  const actorSigTs = Date.now();
  const actorSig = computeRpcActorSignature(
    { actorId: actor.actorId, actorRole: actor.actorRole, actorSid, actorSigTs },
    RPC_SECRET,
  );
  return { ...actor, actorSid, actorSigTs, actorSig };
}

const ADMIN = signed({ actorId: 'a1', actorRole: 'ADMIN' });
const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const SID = '2b8f1d2e-4c5a-4b7e-9a1d-0e2f3a4b5c6d';

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
      { id: 'a1', role: 'ADMIN', sid: '' },
    );
  });

  it('getDetailUser passes the target id, expectedRole and the caller', async () => {
    service.getDetailUserService.mockResolvedValue({ id: USER_ID });
    await controller.getDetailUser({ userId: USER_ID, expectedRole: 'STUDENT', ...ADMIN });
    expect(service.getDetailUserService).toHaveBeenCalledWith({
      id: USER_ID,
      actor: { id: 'a1', role: 'ADMIN', sid: '' },
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
    expect(dto).not.toHaveProperty('actorSig');
    expect(dto).toMatchObject({ email: 'New@Example.test', role: 'TUTOR' });
    expect(actor).toEqual({ id: 'a1', role: 'ADMIN', sid: '' });
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
      ...signed({ actorId: USER_ID, actorRole: 'STUDENT' }),
    } as never);
    expect(service.updateOwnProfileService).toHaveBeenCalledWith({
      id: USER_ID,
      actor: { id: USER_ID, role: 'STUDENT', sid: '' },
      data: { firstName: 'Ann' },
    });
  });

  it('updateStatusUser takes an explicit isActive and rejects a non-boolean', async () => {
    service.updateStatusUserService.mockResolvedValue({});
    await controller.updateStatusUser({ id: USER_ID, isActive: false, ...ADMIN });
    expect(service.updateStatusUserService).toHaveBeenCalledWith({
      id: USER_ID,
      isActive: false,
      actor: { id: 'a1', role: 'ADMIN', sid: '' },
    });
    await expect(
      controller.updateStatusUser({ id: USER_ID, isActive: 'no', ...ADMIN } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('changePassword splits userId from the password fields and passes the caller session', async () => {
    service.changePasswordService.mockResolvedValue({ message: 'ok', refreshToken: 'rt' });
    await controller.changePassword({
      userId: USER_ID,
      currentPassword: 'anything',
      newPassword: 'Abcdef1!',
      ...signed({ actorId: USER_ID, actorRole: 'STUDENT', actorSid: SID }),
    } as never);
    expect(service.changePasswordService).toHaveBeenCalledWith(
      USER_ID,
      { currentPassword: 'anything', newPassword: 'Abcdef1!' },
      SID,
    );
  });

  it('changePassword refuses a userId that is not the forwarded actor', async () => {
    await expect(
      controller.changePassword({
        userId: USER_ID,
        currentPassword: 'anything',
        newPassword: 'Abcdef1!',
        ...signed({ actorId: 'someone-else', actorRole: 'ADMIN', actorSid: SID }),
      } as never),
    ).rejects.toBeDefined();
    expect(service.changePasswordService).not.toHaveBeenCalled();
  });

  it('refuses an actor whose signature does not match (forged role)', async () => {
    const forged = { ...signed({ actorId: 'a1', actorRole: 'STUDENT' }), actorRole: 'ADMIN' };
    await controller.getUsers({ page: '1', limit: '5', ...forged } as never);
    expect(service.getUsersService).toHaveBeenCalledWith(
      { page: 1, limit: 5 },
      { id: '', role: '', sid: '' },
    );
  });

  it('refuses an actor envelope older than the replay window', async () => {
    const stale = signed({ actorId: 'a1', actorRole: 'ADMIN' });
    const old = { ...stale, actorSigTs: stale.actorSigTs - RPC_ACTOR_MAX_AGE_MS - 1_000 };
    const actorSig = computeRpcActorSignature(
      { actorId: 'a1', actorRole: 'ADMIN', actorSid: '', actorSigTs: old.actorSigTs },
      RPC_SECRET,
    );
    await controller.getUsers({ page: '1', limit: '5', ...old, actorSig } as never);
    expect(service.getUsersService).toHaveBeenCalledWith(
      { page: 1, limit: 5 },
      { id: '', role: '', sid: '' },
    );
  });

  it('refuses an unsigned actor', async () => {
    await controller.getUsers({
      page: '1',
      limit: '5',
      actorId: 'a1',
      actorRole: 'ADMIN',
    } as never);
    expect(service.getUsersService).toHaveBeenCalledWith(
      { page: 1, limit: 5 },
      { id: '', role: '', sid: '' },
    );
  });

  it('surfaces service rejections to the RPC caller', async () => {
    service.deleteUserByAdminService.mockRejectedValue(new Error('USER_NOT_FOUND'));
    await expect(controller.deleteUserByAdmin({ id: 'missing', ...ADMIN })).rejects.toThrow(
      'USER_NOT_FOUND',
    );
  });
});
