import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ROLES_KEY } from '@packages/decorators';
import { RolesGuard } from '@packages/guards';
import { AdminController } from 'src/features/admin/admin.controller';
import { AdminService } from 'src/features/admin/admin.service';

const ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_USER = {
  id: ACTOR_ID,
  role: 'ADMIN',
  email: 'admin@example.test',
  typ: 'access',
  sid: ID,
};
const ACTOR = { id: ACTOR_ID, role: 'ADMIN' };

describe('AdminController', () => {
  let controller: AdminController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      createTutor: jest.fn().mockResolvedValue({ id: ID }),
      listTutors: jest.fn().mockResolvedValue({ data: [] }),
      getTutor: jest.fn().mockResolvedValue({ id: ID }),
      updateTutor: jest.fn().mockResolvedValue({ id: ID }),
      deleteTutor: jest.fn().mockResolvedValue({ id: ID }),
      createStudent: jest.fn().mockResolvedValue({ id: ID }),
      listStudents: jest.fn().mockResolvedValue({ data: [] }),
      getStudent: jest.fn().mockResolvedValue({ id: ID }),
      updateStudent: jest.fn().mockResolvedValue({ id: ID }),
      deleteStudent: jest.fn().mockResolvedValue({ id: ID }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: service }],
    }).compile();
    controller = moduleRef.get(AdminController);
  });

  describe('access control', () => {
    it('is mounted under /admin and admin-only at class level', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AdminController)).toBe('admin');
      expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual(['ADMIN']);
      expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toContain(RolesGuard);
    });
  });

  describe('route table', () => {
    it.each<[keyof AdminController, RequestMethod, string]>([
      ['createTutor', RequestMethod.POST, 'tutors'],
      ['listTutors', RequestMethod.GET, 'tutors'],
      ['getTutor', RequestMethod.GET, 'tutors/:id'],
      ['updateTutor', RequestMethod.PUT, 'tutors/:id'],
      ['deleteTutor', RequestMethod.DELETE, 'tutors/:id'],
      ['createStudent', RequestMethod.POST, 'students'],
      ['listStudents', RequestMethod.GET, 'students'],
      ['getStudent', RequestMethod.GET, 'students/:id'],
      ['updateStudent', RequestMethod.PUT, 'students/:id'],
      ['deleteStudent', RequestMethod.DELETE, 'students/:id'],
    ])('%s is %s %s', (name, method, path) => {
      const fn = AdminController.prototype[name] as unknown as object;
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(path);
    });
  });

  describe('delegation to AdminService', () => {
    const dto = { email: 'x@y.z' } as never;
    const query = { page: 1, limit: 10 } as never;

    it('tutor routes forward dto/query/id to the matching tutor method', async () => {
      await controller.createTutor(ADMIN_USER, dto);
      await controller.listTutors(ADMIN_USER, query);
      await controller.getTutor(ADMIN_USER, ID);
      await controller.updateTutor(ADMIN_USER, ID, dto);
      await controller.deleteTutor(ADMIN_USER, ID);
      expect(service.createTutor).toHaveBeenCalledWith(dto, ACTOR);
      expect(service.listTutors).toHaveBeenCalledWith(query, ACTOR);
      expect(service.getTutor).toHaveBeenCalledWith(ID, ACTOR);
      expect(service.updateTutor).toHaveBeenCalledWith(ID, dto, ACTOR);
      expect(service.deleteTutor).toHaveBeenCalledWith(ID, ACTOR);
    });

    it('student routes forward dto/query/id to the matching student method', async () => {
      await controller.createStudent(ADMIN_USER, dto);
      await controller.listStudents(ADMIN_USER, query);
      await controller.getStudent(ADMIN_USER, ID);
      await controller.updateStudent(ADMIN_USER, ID, dto);
      await controller.deleteStudent(ADMIN_USER, ID);
      expect(service.createStudent).toHaveBeenCalledWith(dto, ACTOR);
      expect(service.listStudents).toHaveBeenCalledWith(query, ACTOR);
      expect(service.getStudent).toHaveBeenCalledWith(ID, ACTOR);
      expect(service.updateStudent).toHaveBeenCalledWith(ID, dto, ACTOR);
      expect(service.deleteStudent).toHaveBeenCalledWith(ID, ACTOR);
    });

    it('does not cross-wire tutor and student methods', async () => {
      await controller.getTutor(ADMIN_USER, ID);
      expect(service.getStudent).not.toHaveBeenCalled();
      await controller.getStudent(ADMIN_USER, ID);
      expect(service.getTutor).toHaveBeenCalledTimes(1);
    });

    it('returns whatever the service resolves with', async () => {
      service.listStudents.mockResolvedValueOnce({ data: [{ id: 1 }], total: 1 });
      await expect(controller.listStudents(ADMIN_USER, query)).resolves.toEqual({
        data: [{ id: 1 }],
        total: 1,
      });
    });
  });
});
