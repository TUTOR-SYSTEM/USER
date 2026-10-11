import {
  METHOD_METADATA,
  PATH_METADATA,
  GUARDS_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ROLES_KEY } from '@packages/decorators';
import { RolesGuard } from '@packages/guards';
import { UserController } from 'src/features/user/user.controller';
import { UserService } from 'src/features/user/user.service';

const ACTOR = { id: '22222222-2222-4222-8222-222222222222', role: 'STUDENT' };
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

describe('UserController', () => {
  let controller: UserController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      getUsersService: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
      getDetailUserService: jest.fn().mockResolvedValue({ id: ACTOR.id }),
      findUsersByFieldPublic: jest.fn().mockResolvedValue([]),
      createUserService: jest.fn().mockResolvedValue({ id: TARGET_ID }),
      updateOwnProfileService: jest.fn().mockResolvedValue({ id: ACTOR.id }),
      updateUserService: jest.fn().mockResolvedValue({ id: TARGET_ID }),
      updateStatusUserService: jest.fn().mockResolvedValue({ id: TARGET_ID }),
      deleteUserByAdminService: jest.fn().mockResolvedValue({ id: TARGET_ID }),
      changePasswordService: jest.fn().mockResolvedValue({ ok: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: service }],
    }).compile();
    controller = moduleRef.get(UserController);
  });

  const handlerMeta = (name: keyof UserController) => {
    const fn = UserController.prototype[name] as unknown as object;
    return {
      method: Reflect.getMetadata(METHOD_METADATA, fn),
      path: Reflect.getMetadata(PATH_METADATA, fn),
      roles: Reflect.getMetadata(ROLES_KEY, fn),
      guards: Reflect.getMetadata(GUARDS_METADATA, fn) ?? [],
    };
  };

  describe('route table', () => {
    it('mounts under /users', () => {
      expect(Reflect.getMetadata(PATH_METADATA, UserController)).toBe('users');
    });

    it.each<[keyof UserController, RequestMethod, string]>([
      ['getUsers', RequestMethod.GET, '/'],
      ['getDetailUserController', RequestMethod.GET, '/detail-user'],
      ['getUserByField', RequestMethod.GET, '/get-by-field'],
      ['createUser', RequestMethod.POST, '/'],
      ['updateUserController', RequestMethod.PUT, ''],
      ['updateUserByAdminController', RequestMethod.PUT, '/:id'],
      ['updateStatusUserController', RequestMethod.PUT, '/:id/status'],
      ['deleteUserByAdminController', RequestMethod.DELETE, '/:id'],
      ['changePasswordController', RequestMethod.POST, '/change-password'],
    ])('%s is %s %s', (name, method, path) => {
      const meta = handlerMeta(name);
      expect(meta.method).toBe(method);
      const normalize = (p?: string) => (p ?? '').replace(/^\/+/, '').replace(/^$/, '');
      expect(normalize(meta.path)).toBe(normalize(path));
    });

    it.each<keyof UserController>([
      'getUserByField',
      'createUser',
      'updateUserByAdminController',
      'updateStatusUserController',
      'deleteUserByAdminController',
    ])('%s is admin-only: @Roles(ADMIN) with RolesGuard', (name) => {
      const meta = handlerMeta(name);
      expect(meta.roles).toEqual(['ADMIN']);
      expect(meta.guards).toContain(RolesGuard);
    });

    it.each<keyof UserController>([
      'getDetailUserController',
      'updateUserController',
      'changePasswordController',
    ])('%s is self-service: no role gate, acts on the caller', (name) => {
      expect(handlerMeta(name).roles).toBeUndefined();
    });

    it('KNOWN ISSUE: getUsers (GET /users) has no role gate, so any signed-in role can list all users', () => {
      // Pinned to current behaviour so a fix shows up as a deliberate test change.
      expect(handlerMeta('getUsers').roles).toBeUndefined();
      expect(handlerMeta('getUsers').guards).not.toContain(RolesGuard);
    });

    it('validates list query, create body, and update bodies with their own schemas', () => {
      const argsOf = (name: keyof UserController) =>
        Object.values(
          Reflect.getMetadata(ROUTE_ARGS_METADATA, UserController, name) as Record<
            string,
            { pipes?: { schema?: unknown }[] }
          >,
        ).flatMap((a) => a.pipes ?? []);
      expect(argsOf('getUsers')).toHaveLength(1);
      expect(argsOf('createUser')).toHaveLength(1);
      expect(argsOf('updateUserController')).toHaveLength(1);
      expect(argsOf('updateUserByAdminController')).toHaveLength(1);
      expect(argsOf('changePasswordController')).toHaveLength(1);
    });
  });

  describe('delegation', () => {
    it('getUsers forwards the validated query', async () => {
      const query = { page: 1, limit: 5 } as never;
      await controller.getUsers(query);
      expect(service.getUsersService).toHaveBeenCalledWith(query);
    });

    it('getDetailUserController returns the caller profile by the JWT subject', async () => {
      await controller.getDetailUserController(ACTOR as never);
      expect(service.getDetailUserService).toHaveBeenCalledWith({ id: ACTOR.id });
    });

    it('getUserByField forwards the field filter', async () => {
      const dto = { field: 'email', value: 'a@b.c' } as never;
      await controller.getUserByField(dto);
      expect(service.findUsersByFieldPublic).toHaveBeenCalledWith(dto);
    });

    it('createUser forwards the DTO', async () => {
      const dto = { email: 'n@x.io' } as never;
      await controller.createUser(dto);
      expect(service.createUserService).toHaveBeenCalledWith(dto);
    });

    it('updateUserController scopes the update to the caller id and role (self-service)', async () => {
      const data = { firstName: 'New' } as never;
      await controller.updateUserController(ACTOR as never, data);
      expect(service.updateOwnProfileService).toHaveBeenCalledWith({
        id: ACTOR.id,
        role: ACTOR.role,
        data,
      });
    });

    it('updateUserByAdminController uses the :id param, not the caller', async () => {
      const data = { isActive: false } as never;
      await controller.updateUserByAdminController(TARGET_ID, data);
      expect(service.updateUserService).toHaveBeenCalledWith({ id: TARGET_ID, data });
    });

    it('updateStatusUserController forwards only the id', async () => {
      await controller.updateStatusUserController(TARGET_ID);
      expect(service.updateStatusUserService).toHaveBeenCalledWith({ id: TARGET_ID });
    });

    it('deleteUserByAdminController forwards only the id', async () => {
      await controller.deleteUserByAdminController(TARGET_ID);
      expect(service.deleteUserByAdminService).toHaveBeenCalledWith({ id: TARGET_ID });
    });

    it('changePasswordController uses the caller id, never a body id', async () => {
      const dto = { currentPassword: 'old', newPassword: 'new' } as never;
      await controller.changePasswordController(ACTOR as never, dto);
      expect(service.changePasswordService).toHaveBeenCalledWith(ACTOR.id, dto);
    });

    it('propagates service errors unchanged', async () => {
      service.deleteUserByAdminService.mockRejectedValueOnce(new Error('nope'));
      await expect(controller.deleteUserByAdminController(TARGET_ID)).rejects.toThrow('nope');
    });
  });
});
