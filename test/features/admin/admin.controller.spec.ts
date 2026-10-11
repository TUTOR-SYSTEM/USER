import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ROLES_KEY } from '@packages/decorators';
import { RolesGuard } from '@packages/guards';
import { AdminController } from 'src/features/admin/admin.controller';
import { AdminService } from 'src/features/admin/admin.service';

const ID = '33333333-3333-4333-8333-333333333333';

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
      await controller.createTutor(dto);
      await controller.listTutors(query);
      await controller.getTutor(ID);
      await controller.updateTutor(ID, dto);
      await controller.deleteTutor(ID);
      expect(service.createTutor).toHaveBeenCalledWith(dto);
      expect(service.listTutors).toHaveBeenCalledWith(query);
      expect(service.getTutor).toHaveBeenCalledWith(ID);
      expect(service.updateTutor).toHaveBeenCalledWith(ID, dto);
      expect(service.deleteTutor).toHaveBeenCalledWith(ID);
    });

    it('student routes forward dto/query/id to the matching student method', async () => {
      await controller.createStudent(dto);
      await controller.listStudents(query);
      await controller.getStudent(ID);
      await controller.updateStudent(ID, dto);
      await controller.deleteStudent(ID);
      expect(service.createStudent).toHaveBeenCalledWith(dto);
      expect(service.listStudents).toHaveBeenCalledWith(query);
      expect(service.getStudent).toHaveBeenCalledWith(ID);
      expect(service.updateStudent).toHaveBeenCalledWith(ID, dto);
      expect(service.deleteStudent).toHaveBeenCalledWith(ID);
    });

    it('does not cross-wire tutor and student methods', async () => {
      await controller.getTutor(ID);
      expect(service.getStudent).not.toHaveBeenCalled();
      await controller.getStudent(ID);
      expect(service.getTutor).toHaveBeenCalledTimes(1);
    });

    it('returns whatever the service resolves with', async () => {
      service.listStudents.mockResolvedValueOnce({ data: [{ id: 1 }], total: 1 });
      await expect(controller.listStudents(query)).resolves.toEqual({
        data: [{ id: 1 }],
        total: 1,
      });
    });
  });
});
