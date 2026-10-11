import { Test } from '@nestjs/testing';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ROLES_KEY } from '@packages/decorators';
import { RolesGuard } from '@packages/guards';
import { ZodValidationPipe } from '@packages/pipes';
import { StudentController } from 'src/features/student/student.controller';
import { StudentService } from 'src/features/student/student.service';
import type { JwtGuardUser } from 'src/packages/guards/jwt-auth.guard';

const TUTOR: JwtGuardUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'tutor@example.com',
  typ: 'access',
  role: 'TUTOR',
};

const STUDENT_ID = '33333333-3333-4333-8333-333333333333';

describe('StudentController', () => {
  let controller: StudentController;
  let service: Record<
    'generateStudentCodeService' | 'create' | 'findAll' | 'findById' | 'update' | 'delete',
    jest.Mock
  >;

  beforeEach(async () => {
    service = {
      generateStudentCodeService: jest.fn().mockResolvedValue('CODE42'),
      create: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      findAll: jest.fn().mockResolvedValue({ students: [], pagination: {} }),
      findById: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      update: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      delete: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [StudentController],
      providers: [{ provide: StudentService, useValue: service }],
    }).compile();
    controller = moduleRef.get(StudentController);
  });

  describe('route table', () => {
    const routeOf = (handler: keyof StudentController) => {
      const fn = StudentController.prototype[handler] as unknown as object;
      return {
        method: Reflect.getMetadata(METHOD_METADATA, fn),
        path: Reflect.getMetadata(PATH_METADATA, fn),
      };
    };

    it('mounts under the plural /students prefix', () => {
      expect(Reflect.getMetadata(PATH_METADATA, StudentController)).toBe('students');
    });

    it.each<[keyof StudentController, RequestMethod, string | undefined]>([
      ['generateStudentCodeController', RequestMethod.GET, 'get-student-code'],
      ['create', RequestMethod.POST, undefined],
      ['getAllStudents', RequestMethod.GET, undefined],
      ['findById', RequestMethod.GET, ':id'],
      ['update', RequestMethod.PUT, ':id'],
      ['delete', RequestMethod.DELETE, ':id'],
    ])('%s is %s %s', (handler, method, path) => {
      const meta = routeOf(handler);
      expect(meta.method).toBe(method);
      // Nest stores "/" (or nothing) for handlers without an explicit segment.
      const normalize = (value?: string) => (!value || value === '/' ? '' : value);
      expect(normalize(meta.path)).toBe(normalize(path));
    });

    it.each<[keyof StudentController, string]>([
      ['create', 'createStudentSchema'],
      ['getAllStudents', 'getStudentsQuerySchema'],
      ['update', 'updateStudentSchema'],
    ])('%s validates input with %s', (handler, schemaName) => {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, StudentController, handler) as Record<
        string,
        { pipes?: unknown[] }
      >;
      const pipes = Object.values(args).flatMap((a) => a.pipes ?? []) as ZodValidationPipe[];
      const schemas = pipes.map((p) => (p as unknown as { schema: unknown }).schema);
      const expected = jest.requireActual('@packages/entities/student')[schemaName];
      expect(pipes.every((p) => p instanceof ZodValidationPipe)).toBe(true);
      expect(schemas).toContain(expected);
    });
  });

  describe('delegation', () => {
    it('returns the generated code from the service', async () => {
      await expect(controller.generateStudentCodeController()).resolves.toBe('CODE42');
      expect(service.generateStudentCodeService).toHaveBeenCalledTimes(1);
    });

    it('forwards the validated body and the acting user to create', async () => {
      const dto = { studentName: 'A B' } as never;
      await expect(controller.create(dto, TUTOR)).resolves.toEqual({ id: STUDENT_ID });
      expect(service.create).toHaveBeenCalledWith(dto, TUTOR);
    });

    it('forwards list query to findAll and returns its result', async () => {
      const query = { page: 2, limit: 5, search: 'an' } as never;
      await controller.getAllStudents(query);
      expect(service.findAll).toHaveBeenCalledWith(query);
    });

    it('forwards the id param to findById', async () => {
      await controller.findById(STUDENT_ID);
      expect(service.findById).toHaveBeenCalledWith(STUDENT_ID);
    });

    it('forwards id and dto to update in that order', async () => {
      const dto = { school: 'X' } as never;
      await controller.update(STUDENT_ID, dto);
      expect(service.update).toHaveBeenCalledWith(STUDENT_ID, dto);
    });

    it('forwards the id param to delete', async () => {
      await controller.delete(STUDENT_ID);
      expect(service.delete).toHaveBeenCalledWith(STUDENT_ID);
    });

    it('propagates service errors unchanged', async () => {
      service.findById.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.findById(STUDENT_ID)).rejects.toThrow('boom');
    });
  });

  describe('access control', () => {
    it('KNOWN ISSUE: the student controller has no RolesGuard or @Roles, so any signed-in role reaches create/update/delete', () => {
      // Pinned to current behaviour. Routes are only protected by the global JwtAuthGuard.
      expect(Reflect.getMetadata(ROLES_KEY, StudentController)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, StudentController) ?? []).not.toContain(
        RolesGuard,
      );
    });
  });
});
