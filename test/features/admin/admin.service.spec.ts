import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { compareData } from '@packages/helpers';
import { ERROR_MESSAGES } from 'src/data/constants';
import { AdminService } from 'src/features/admin/admin.service';
import type { AdminRepository } from 'src/features/admin/admin.repository';

// admin.repository imports Drizzle + `@packages/database/schema`, which jest cannot resolve here.
// The service only needs the class token; every repository call is mocked below.
jest.mock('src/features/admin/admin.repository', () => ({
  AdminRepository: class AdminRepository {},
}));

const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const OTHER_ID = '0b9e7d1a-2c3f-4a5b-9c8d-7e6f5a4b3c2d';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'managed@example.test',
    username: 'managed',
    firstName: 'Ann',
    lastName: 'Le',
    role: 'TUTOR',
    subjects: 'Math, Physics',
    isActive: true,
    ...overrides,
  };
}

describe('AdminService', () => {
  let service: AdminService;
  let repo: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    repo = {
      findByEmail: jest.fn().mockResolvedValue([]),
      findByUsername: jest.fn().mockResolvedValue([]),
      findByUserCode: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (values: Record<string, unknown>) => ({
        ...values,
        subjects: values.subjects ?? null,
      })),
      findByIdAndRole: jest.fn().mockResolvedValue(undefined),
      findStudentDetail: jest.fn().mockResolvedValue(undefined),
      findParentInfo: jest.fn().mockResolvedValue(null),
      existsWithRole: jest.fn().mockResolvedValue(true),
      updateByIdAndRole: jest.fn().mockResolvedValue(undefined),
      deleteByIdAndRole: jest.fn().mockResolvedValue(undefined),
      list: jest.fn().mockResolvedValue({ rows: [], pagination: { total: 0 } }),
    };
    service = new AdminService(repo as unknown as AdminRepository);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createDto = {
    email: '  New.Tutor@Example.TEST ',
    firstName: 'Bao',
    lastName: 'Tran',
    password: 'Plain-1',
    subjects: ['Math', ' Physics ', ''],
  };

  describe('createTutor / createStudent', () => {
    it('lowercases and trims the email, hashes the password and assigns a userCode to tutors', async () => {
      await service.createTutor(createDto as never);

      const values = repo.create.mock.calls[0][0] as Record<string, string>;
      expect(values.email).toBe('new.tutor@example.test');
      expect(values.role).toBe('TUTOR');
      expect(values.userCode).toMatch(/^[0-9A-Z]{6}$/);
      expect(values.password).not.toBe('Plain-1');
      await expect(compareData('Plain-1', values.password)).resolves.toBe(true);
    });

    it('does not assign a userCode to students and joins subjects into one string', async () => {
      await service.createStudent(createDto as never);

      const values = repo.create.mock.calls[0][0] as Record<string, unknown>;
      expect(values.role).toBe('STUDENT');
      expect(values).not.toHaveProperty('userCode');
      expect(values.subjects).toBe('Math, Physics');
    });

    it('rejects an email already in use, case-insensitively', async () => {
      repo.findByEmail.mockResolvedValue([row()]);

      await expect(service.createTutor(createDto as never)).rejects.toMatchObject({
        message: `${ERROR_MESSAGES.EMAIL_EXISTS}: new.tutor@example.test`,
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a supplied username that is already taken', async () => {
      repo.findByUsername.mockResolvedValue([row()]);

      await expect(
        service.createStudent({ ...createDto, username: 'taken' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('list endpoints (role isolation)', () => {
    it('returns tutors under the "tutors" key and splits subjects into an array', async () => {
      repo.list.mockResolvedValue({ rows: [row()], pagination: { total: 1 } });

      const result = await service.listTutors({ page: 1, limit: 10 } as never);

      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ role: 'TUTOR' }));
      expect(result).toEqual({
        tutors: [expect.objectContaining({ subjects: ['Math', 'Physics'] })],
        pagination: { total: 1 },
      });
    });

    it('lists students only under the "students" key', async () => {
      repo.list.mockResolvedValue({
        rows: [row({ role: 'STUDENT', subjects: null })],
        pagination: {},
      });

      const result = await service.listStudents({ page: 1, limit: 10 } as never);

      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ role: 'STUDENT' }));
      expect(result).toHaveProperty('students');
      expect(result).not.toHaveProperty('tutors');
      expect(result.students[0].subjects).toEqual([]);
    });
  });

  describe('getTutor / getStudent', () => {
    it('rejects a malformed id before querying', async () => {
      await expect(service.getTutor('not-a-uuid')).rejects.toMatchObject({
        constructor: BadRequestException,
        message: ERROR_MESSAGES.ADMIN_INVALID_ID,
      });
      expect(repo.findByIdAndRole).not.toHaveBeenCalled();
    });

    it('returns NotFound with the tutor-specific message when the id is not a tutor', async () => {
      await expect(service.getTutor(USER_ID)).rejects.toMatchObject({
        constructor: NotFoundException,
        message: ERROR_MESSAGES.TUTOR_NOT_FOUND,
      });
      expect(repo.findByIdAndRole).toHaveBeenCalledWith(USER_ID, 'TUTOR');
    });

    it('returns NotFound with the student-specific message for a missing student', async () => {
      await expect(service.getStudent(USER_ID)).rejects.toMatchObject({
        message: ERROR_MESSAGES.STUDENT_NOT_FOUND,
      });
    });

    it('attaches the parent summary when the student has a parent', async () => {
      repo.findStudentDetail.mockResolvedValue(row({ role: 'STUDENT', parentId: OTHER_ID }));
      repo.findParentInfo.mockResolvedValue({ id: OTHER_ID, firstName: 'Parent' });

      const result = await service.getStudent(USER_ID);

      expect(repo.findParentInfo).toHaveBeenCalledWith(OTHER_ID);
      expect(result.parent).toEqual({ id: OTHER_ID, firstName: 'Parent' });
      expect(result).not.toHaveProperty('parentId');
    });

    it('returns parent: null and skips the parent lookup when none is linked', async () => {
      repo.findStudentDetail.mockResolvedValue(row({ role: 'STUDENT', parentId: null }));

      const result = await service.getStudent(USER_ID);

      expect(repo.findParentInfo).not.toHaveBeenCalled();
      expect(result.parent).toBeNull();
    });
  });

  describe('updateStudent', () => {
    beforeEach(() => {
      repo.findByIdAndRole.mockResolvedValue(row({ role: 'STUDENT' }));
      repo.updateByIdAndRole.mockResolvedValue(row({ role: 'STUDENT' }));
      repo.findStudentDetail.mockResolvedValue(row({ role: 'STUDENT' }));
    });

    it('rejects a userCode that belongs to a different student', async () => {
      repo.findByUserCode.mockResolvedValue([row({ id: OTHER_ID })]);

      await expect(
        service.updateStudent(USER_ID, { userCode: 'ABC123' } as never),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        message: `${ERROR_MESSAGES.STUDENT_CODE_EXISTS}: ABC123`,
      });
      expect(repo.updateByIdAndRole).not.toHaveBeenCalled();
    });

    it("allows keeping the student's own userCode", async () => {
      repo.findByUserCode.mockResolvedValue([row({ id: USER_ID })]);

      await expect(
        service.updateStudent(USER_ID, { userCode: 'ABC123' } as never),
      ).resolves.toBeDefined();
    });

    it('rejects a parentId that is not a PARENT account', async () => {
      repo.existsWithRole.mockResolvedValue(false);

      await expect(
        service.updateStudent(USER_ID, { parentId: OTHER_ID } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.PARENT_NOT_FOUND,
      });
      expect(repo.existsWithRole).toHaveBeenCalledWith(OTHER_ID, 'PARENT');
    });

    it('rejects a tutorId that is not a TUTOR account', async () => {
      repo.existsWithRole.mockResolvedValue(false);

      await expect(
        service.updateStudent(USER_ID, { tutorId: OTHER_ID } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.TUTOR_NOT_FOUND,
      });
      expect(repo.existsWithRole).toHaveBeenCalledWith(OTHER_ID, 'TUTOR');
    });

    it('writes through the STUDENT role and returns the enriched student', async () => {
      const result = await service.updateStudent(USER_ID, { firstName: 'Changed' } as never);

      expect(repo.updateByIdAndRole).toHaveBeenCalledWith(
        USER_ID,
        'STUDENT',
        expect.objectContaining({ firstName: 'Changed' }),
      );
      expect(result).toHaveProperty('parent');
    });
  });

  describe('updateTutor (shared update path)', () => {
    beforeEach(() => {
      repo.findByIdAndRole.mockResolvedValue(row());
      repo.updateByIdAndRole.mockResolvedValue(row());
    });

    it('rejects an email that another account already uses', async () => {
      repo.findByEmail.mockResolvedValue([row({ id: OTHER_ID })]);

      await expect(
        service.updateTutor(USER_ID, { email: 'dup@example.test' } as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.updateByIdAndRole).not.toHaveBeenCalled();
    });

    it('clears subjects when an empty list is sent', async () => {
      await service.updateTutor(USER_ID, { subjects: [] } as never);

      expect(repo.updateByIdAndRole).toHaveBeenCalledWith(
        USER_ID,
        'TUTOR',
        expect.objectContaining({ subjects: null }),
      );
    });

    it('trims and joins subjects when a list is sent', async () => {
      await service.updateTutor(USER_ID, { subjects: ['a', ' b '] } as never);

      expect(repo.updateByIdAndRole).toHaveBeenCalledWith(
        USER_ID,
        'TUTOR',
        expect.objectContaining({ subjects: 'a, b' }),
      );
    });

    it('returns NotFound when the row vanishes between the read and the write', async () => {
      repo.updateByIdAndRole.mockResolvedValue(undefined);

      await expect(service.updateTutor(USER_ID, { firstName: 'X' } as never)).rejects.toMatchObject(
        {
          message: ERROR_MESSAGES.TUTOR_NOT_FOUND,
        },
      );
    });
  });

  describe('uniqueness branches', () => {
    beforeEach(() => {
      repo.findByIdAndRole.mockResolvedValue(row());
      repo.updateByIdAndRole.mockResolvedValue(row());
    });

    it('normalizes a new email (trim + lowercase) when no other account uses it', async () => {
      await service.updateTutor(USER_ID, { email: '  Fresh.Mail@EXAMPLE.test ' } as never);

      expect(repo.findByEmail).toHaveBeenCalledWith('fresh.mail@example.test');
      expect(repo.updateByIdAndRole).toHaveBeenCalledWith(
        USER_ID,
        'TUTOR',
        expect.objectContaining({ email: 'fresh.mail@example.test' }),
      );
    });

    it('rejects a username that another account already uses', async () => {
      repo.findByUsername.mockResolvedValue([row({ id: OTHER_ID })]);

      await expect(
        service.updateTutor(USER_ID, { username: ' taken ' } as never),
      ).rejects.toMatchObject({
        message: `${ERROR_MESSAGES.USERNAME_EXISTS}: taken`,
      });
      expect(repo.updateByIdAndRole).not.toHaveBeenCalled();
    });

    it('allows keeping the username the row already has', async () => {
      repo.findByUsername.mockResolvedValue([row({ id: USER_ID })]);

      await service.updateTutor(USER_ID, { username: 'managed' } as never);

      expect(repo.updateByIdAndRole).toHaveBeenCalledWith(
        USER_ID,
        'TUTOR',
        expect.objectContaining({ username: 'managed' }),
      );
    });

    it('keeps a supplied free username on create (trimmed)', async () => {
      await service.createTutor({ ...createDto, username: '  bao.tran  ' } as never);

      expect(repo.findByUsername).toHaveBeenCalledWith('bao.tran');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'bao.tran' }));
    });

    it('gives up with Conflict once every generated username candidate is taken', async () => {
      repo.findByUsername.mockResolvedValue([row({ id: OTHER_ID })]);

      await expect(service.createStudent(createDto as never)).rejects.toMatchObject({
        message: `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: Bao Tran`,
      });
      expect(repo.findByUsername).toHaveBeenCalledTimes(10);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('gives up with Conflict after 5 colliding user codes', async () => {
      repo.findByUserCode.mockResolvedValue([row({ id: OTHER_ID })]);

      await expect(service.createTutor(createDto as never)).rejects.toMatchObject({
        message: ERROR_MESSAGES.UNABLE_TO_GENERATE_USER_CODE,
      });
      expect(repo.findByUserCode).toHaveBeenCalledTimes(5);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('remaining admin branches', () => {
    it('updateStudent reports the student-specific NotFound when the id is not a student', async () => {
      repo.findByIdAndRole.mockResolvedValue(undefined);

      await expect(
        service.updateStudent(USER_ID, { firstName: 'X' } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.STUDENT_NOT_FOUND,
      });
      expect(repo.updateByIdAndRole).not.toHaveBeenCalled();
    });

    it('updateStudent returns the student-specific NotFound when the write matches no row', async () => {
      repo.findByIdAndRole.mockResolvedValue(row({ role: 'STUDENT' }));
      repo.updateByIdAndRole.mockResolvedValue(undefined);

      await expect(
        service.updateStudent(USER_ID, { firstName: 'X' } as never),
      ).rejects.toMatchObject({
        message: ERROR_MESSAGES.STUDENT_NOT_FOUND,
      });
    });

    it('deleteTutor reports the tutor-specific NotFound when nothing is deleted', async () => {
      repo.deleteByIdAndRole.mockResolvedValue(undefined);

      await expect(service.deleteTutor(USER_ID)).rejects.toMatchObject({
        message: ERROR_MESSAGES.TUTOR_NOT_FOUND,
      });
    });

    it('creates a student without subjects and stores no subjects value', async () => {
      const { subjects: _omit, ...withoutSubjects } = createDto;

      await service.createStudent(withoutSubjects as never);

      const values = repo.create.mock.calls[0][0] as Record<string, unknown>;
      expect(values.subjects).toBeUndefined();
    });
  });

  describe('deleteTutor / deleteStudent', () => {
    it('deletes only within the requested role', async () => {
      repo.deleteByIdAndRole.mockResolvedValue({ id: USER_ID });

      await expect(service.deleteTutor(USER_ID)).resolves.toEqual({ id: USER_ID });
      expect(repo.deleteByIdAndRole).toHaveBeenCalledWith(USER_ID, 'TUTOR');

      await service.deleteStudent(USER_ID);
      expect(repo.deleteByIdAndRole).toHaveBeenLastCalledWith(USER_ID, 'STUDENT');
    });

    it('returns the student-specific NotFound when deleting a non-student id', async () => {
      await expect(service.deleteStudent(USER_ID)).rejects.toMatchObject({
        message: ERROR_MESSAGES.STUDENT_NOT_FOUND,
      });
    });

    it('rejects a malformed id without touching the database', async () => {
      await expect(service.deleteTutor('bad')).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.deleteByIdAndRole).not.toHaveBeenCalled();
    });
  });
});
