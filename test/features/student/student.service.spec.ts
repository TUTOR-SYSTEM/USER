import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ERROR_MESSAGES } from 'src/data/constants';
import { StudentService } from 'src/features/student/student.service';
import { StudentRepository } from 'src/features/student/student.repository';
import { generateCode, generateRandomPassword, hashData } from '@packages/helpers';
import type { JwtGuardUser } from 'src/packages/guards/jwt-auth.guard';
import { RmqProducer } from 'src/features/rabbitmq/rmq.producer';

jest.mock('@packages/helpers', () => ({
  ...jest.requireActual('@packages/helpers'),
  generateCode: jest.fn(),
  generateRandomPassword: jest.fn(),
  hashData: jest.fn(),
}));

const mockedGenerateCode = generateCode as jest.Mock;
const mockedHashData = hashData as jest.Mock;
const mockedRandomPassword = generateRandomPassword as jest.Mock;

const TUTOR: JwtGuardUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'tutor@example.com',
  typ: 'access',
  role: 'TUTOR',
};

const ADMIN_ACTOR = { id: '55555555-5555-4555-8555-555555555555', role: 'ADMIN' };
const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
const PARENT_ID = '44444444-4444-4444-8444-444444444444';

type DbRows = { id: string }[];

/** `usernameExists` answers per call: a non-empty entry means that candidate is taken. */
function makeUsernameExists(usernameRowsPerCall: DbRows[] = []) {
  const queue = [...usernameRowsPerCall];
  return jest.fn(async () => (queue.shift() ?? []).length > 0);
}

describe('StudentService', () => {
  let service: StudentService;
  let rmq: { send: jest.Mock; emit: jest.Mock };
  let repo: {
    getStudentByField: jest.Mock;
    createParent: jest.Mock;
    createStudent: jest.Mock;
    createStudentWithNewParent: jest.Mock;
    createParentAndLinkStudent: jest.Mock;
    findUserByEmail: jest.Mock;
    getParents: jest.Mock;
    getAllStudents: jest.Mock;
    findById: jest.Mock;
    update: jest.Mock;
    updateParent: jest.Mock;
    findParentForActor: jest.Mock;
    findTutorById: jest.Mock;
    hasEnrollmentWithOtherTutor: jest.Mock;
    findClassesByStudentIds: jest.Mock;
    delete: jest.Mock;
    usernameExists: jest.Mock;
    applyStudentUpdate: jest.Mock;
  };

  const build = async (usernameRows: DbRows[] = []) => {
    // create() generates the student's default password first, then the parent's.
    mockedRandomPassword.mockReset();
    mockedRandomPassword.mockReturnValueOnce('Student@123456').mockReturnValueOnce('Parent@123456');
    repo = {
      getStudentByField: jest.fn().mockResolvedValue(undefined),
      // Emulates the single transaction on top of the per-step mocks, so the assertions below still
      // see the same writes (parent row, new parent link, student row) they did before.
      applyStudentUpdate: jest.fn(
        async (args: {
          studentId: string;
          studentData: Record<string, unknown>;
          parentId?: string;
          parentUpdate?: { id: string; data: Record<string, unknown> };
          newParent?: Record<string, unknown>;
        }) => {
          if (args.parentUpdate) {
            await repo.updateParent({ id: args.parentUpdate.id, data: args.parentUpdate.data });
          }
          if (args.newParent) {
            await repo.createParentAndLinkStudent({
              studentId: args.studentId,
              parent: args.newParent,
            });
          }
          const linkTo = args.newParent ? undefined : args.parentId;
          const data = {
            ...args.studentData,
            ...(linkTo !== undefined ? { parentId: linkTo } : {}),
          };
          if (Object.keys(data).length === 0) return repo.findById({ id: args.studentId });
          return repo.update({ id: args.studentId, data });
        },
      ),
      createParent: jest.fn().mockImplementation(async (d) => ({ ...d, id: d.id })),
      createStudent: jest.fn().mockImplementation(async (d) => ({ ...d })),
      createStudentWithNewParent: jest.fn().mockImplementation(async (_p, s) => ({ ...s })),
      createParentAndLinkStudent: jest.fn().mockResolvedValue({ id: STUDENT_ID }),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      getParents: jest.fn().mockResolvedValue({ parents: [], total: 0 }),
      getAllStudents: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      updateParent: jest.fn(),
      findParentForActor: jest.fn(),
      findTutorById: jest.fn(),
      hasEnrollmentWithOtherTutor: jest.fn().mockResolvedValue(false),
      findClassesByStudentIds: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
      usernameExists: makeUsernameExists(usernameRows),
    };
    rmq = { send: jest.fn(), emit: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudentService,
        { provide: StudentRepository, useValue: repo },
        { provide: RmqProducer, useValue: rmq },
      ],
    }).compile();
    service = moduleRef.get(StudentService);
  };

  describe('setPassword', () => {
    const STUDENT_ID = '33333333-3333-4333-8333-333333333333';
    const ADMIN_ACTOR = { id: '55555555-5555-4555-8555-555555555555', role: 'ADMIN' as const };

    it('ends every session of the student, not only the password change', async () => {
      await build();
      repo.findById.mockResolvedValue({ id: STUDENT_ID, tutorId: null });

      await service.setPassword(STUDENT_ID, 'New-pass-1', ADMIN_ACTOR);

      expect(rmq.send).toHaveBeenCalledWith('redis.delByPrefix', {
        prefix: `session:${STUDENT_ID}:`,
      });
      expect(rmq.send).toHaveBeenCalledWith('redis.delByPrefix', {
        prefix: `refresh:${STUDENT_ID}:`,
      });
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedGenerateCode.mockReset().mockReturnValue('CODE001');
    mockedHashData.mockReset().mockImplementation(async (v: string) => `hashed:${v}`);
    await build();
  });

  describe('generateStudentCodeService', () => {
    it('returns the first generated code when it is free', async () => {
      mockedGenerateCode.mockReturnValueOnce('NEW123');
      await expect(service.generateStudentCodeService()).resolves.toBe('NEW123');
      expect(repo.getStudentByField).toHaveBeenCalledWith({ field: 'userCode', value: 'NEW123' });
    });

    it('regenerates until it finds an unused code', async () => {
      mockedGenerateCode
        .mockReturnValueOnce('TAKEN1')
        .mockReturnValueOnce('TAKEN2')
        .mockReturnValueOnce('FREE3');
      repo.getStudentByField
        .mockResolvedValueOnce({ id: 'x' })
        .mockResolvedValueOnce({ id: 'y' })
        .mockResolvedValueOnce(undefined);
      await expect(service.generateStudentCodeService()).resolves.toBe('FREE3');
      expect(repo.getStudentByField).toHaveBeenCalledTimes(3);
    });

    it('throws Conflict after 5 colliding attempts', async () => {
      repo.getStudentByField.mockResolvedValue({ id: 'taken' });
      await expect(service.generateStudentCodeService()).rejects.toThrow(ConflictException);
      await expect(service.generateStudentCodeService()).rejects.toThrow(
        ERROR_MESSAGES.UNABLE_TO_GENERATE_UNIQUE_CODE,
      );
    });

    it('gives up after exactly 5 checks, not earlier', async () => {
      repo.getStudentByField.mockResolvedValue({ id: 'taken' });
      await expect(service.generateStudentCodeService()).rejects.toBeInstanceOf(ConflictException);
      expect(repo.getStudentByField).toHaveBeenCalledTimes(5);
      expect(mockedGenerateCode).toHaveBeenCalledTimes(5);
    });
  });

  describe('create', () => {
    const baseDto = { studentName: 'Nguyen Van A' };
    const MANAGED_TUTOR_ID = '66666666-6666-4666-8666-666666666666';

    it('requires admin to choose the managing tutor (422 on field tutorId)', async () => {
      const err = await service.create({ ...baseDto }, ADMIN_ACTOR).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(err.getResponse()).toMatchObject({
        errors: [{ field: 'tutorId', message: ERROR_MESSAGES.STUDENT_TUTOR_REQUIRED }],
      });
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('rejects a managing tutor id that is not a TUTOR account', async () => {
      repo.findTutorById.mockResolvedValueOnce(null);
      const err = await service
        .create({ ...baseDto, tutorId: MANAGED_TUTOR_ID }, ADMIN_ACTOR)
        .catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('assigns the student to the tutor the admin picked', async () => {
      repo.findTutorById.mockResolvedValueOnce({ id: MANAGED_TUTOR_ID, role: 'TUTOR' });
      await service.create({ ...baseDto, tutorId: MANAGED_TUTOR_ID }, ADMIN_ACTOR);
      expect(repo.findTutorById).toHaveBeenCalledWith({ id: MANAGED_TUTOR_ID });
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ tutorId: MANAGED_TUTOR_ID }),
      );
    });

    it('always assigns a tutor-created student to the acting tutor, ignoring any tutorId in the body', async () => {
      await service.create({ ...baseDto, tutorId: MANAGED_TUTOR_ID } as never, TUTOR);
      expect(repo.findTutorById).not.toHaveBeenCalled();
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ tutorId: TUTOR.id }),
      );
    });

    it('rejects an explicit userCode that is already taken, without inserting', async () => {
      repo.getStudentByField.mockResolvedValueOnce({ id: 'someone' });
      const err = await service.create({ ...baseDto, userCode: 'STU001' }, TUTOR).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        message: ERROR_MESSAGES.VALIDATION_FAILED,
        errors: [{ field: 'userCode', message: ERROR_MESSAGES.STUDENT_CODE_EXISTS }],
      });
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('keeps an explicit userCode that is free (no silent replacement)', async () => {
      await service.create({ ...baseDto, userCode: 'STU777' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ userCode: 'STU777' }),
      );
      expect(mockedGenerateCode).not.toHaveBeenCalled();
    });

    it('auto-generates a unique code when userCode is absent', async () => {
      mockedGenerateCode.mockReturnValueOnce('AUTO01');
      await service.create(baseDto, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ userCode: 'AUTO01' }),
      );
    });

    it('gives a parent without an email a unique placeholder (users.email is UNIQUE)', async () => {
      await service.create(
        { studentName: 'Nguyen Van A', parentName: 'Tran Thi B' } as never,
        TUTOR,
      );
      expect(repo.createStudentWithNewParent).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'tranthi_b@no-email.local' }),
        expect.anything(),
      );
    });

    it('splits the full name on the first space: first word is the family name (lastName)', async () => {
      await service.create({ studentName: 'Nguyen Van A' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ lastName: 'Nguyen', firstName: 'Van A' }),
      );
    });

    it('treats a single-word name as firstName with empty lastName', async () => {
      await service.create({ studentName: 'Minh' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: 'Minh', lastName: '' }),
      );
    });

    it('builds a lowercase ascii username from lastName+firstName, stripping diacritics', async () => {
      await service.create({ studentName: 'Nguyễn Văn Ánh' }, TUTOR);
      // lastName = "Nguyễn", firstName = "Văn Ánh" -> "Nguyễn" + "Văn Ánh" -> ascii
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'nguyenvan_anh' }),
      );
    });

    it('appends _1, _2 ... while the username is taken', async () => {
      // first candidate taken, second free (base is lastName+firstName = 'NguyenVan A')
      await build([[{ id: 'taken' }], []]);
      await service.create({ studentName: 'Nguyen Van A' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'nguyenvan_a_1' }),
      );
    });

    it('throws Conflict when every sequential and random username candidate is taken', async () => {
      await build(Array.from({ length: 15 }, () => [{ id: 'taken' }]));
      await expect(service.create({ studentName: 'Nguyen Van A' }, TUTOR)).rejects.toThrow(
        `${ERROR_MESSAGES.UNABLE_TO_GENERATE_USERNAME}: Nguyen Van A`,
      );
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('hashes the student default password and stores it', async () => {
      await service.create(baseDto, TUTOR);
      expect(mockedHashData).toHaveBeenCalledWith('Student@123456');
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ password: 'hashed:Student@123456' }),
      );
    });

    it('uses the provided email, otherwise a synthetic <username>@no-email.local', async () => {
      await service.create({ ...baseDto, email: 'real@example.com' }, TUTOR);
      expect(repo.createStudent).toHaveBeenLastCalledWith(
        expect.objectContaining({ email: 'real@example.com' }),
      );

      await service.create(baseDto, TUTOR);
      expect(repo.createStudent).toHaveBeenLastCalledWith(
        expect.objectContaining({ email: 'nguyenvan_a@no-email.local' }),
      );
    });

    it('records the acting user as tutorId and sets parentId null when no parent', async () => {
      await service.create(baseDto, TUTOR);
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ tutorId: TUTOR.id, parentId: null, avatar: null }),
      );
    });

    it('creates a linked PARENT first when parentName is supplied', async () => {
      mockedGenerateCode.mockReturnValueOnce('STUCODE').mockReturnValueOnce('PARCODE');
      await service.create(
        {
          studentName: 'Nguyen Van A',
          parentName: 'Tran Thi B',
          parentRelationship: 'MOTHER',
          parentPhone: '0900000000',
          parentEmail: 'parent@example.com',
        },
        TUTOR,
      );

      expect(repo.createStudentWithNewParent).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'Thi B',
          lastName: 'Tran',
          email: 'parent@example.com',
          phone: '0900000000',
          relationship: 'MOTHER',
          gender: 'FEMALE',
          userCode: 'PARCODE',
          tutorId: TUTOR.id,
          password: 'hashed:Parent@123456',
        }),
        expect.objectContaining({ parentId: expect.any(String), userCode: 'STUCODE' }),
      );
    });

    it.each([
      ['FATHER', 'MALE'],
      ['MOTHER', 'FEMALE'],
      ['GUARDIAN', 'FEMALE'],
    ])('maps parentRelationship %s to parent gender %s', async (relationship, gender) => {
      await service.create(
        { studentName: 'A B', parentName: 'C D', parentRelationship: relationship as never },
        TUTOR,
      );
      expect(repo.createStudentWithNewParent).toHaveBeenCalledWith(
        expect.objectContaining({ gender }),
        expect.anything(),
      );
    });

    it('defaults parent phone/relationship to null and email to a unique placeholder', async () => {
      await service.create({ studentName: 'A B', parentName: 'C D' }, TUTOR);
      expect(repo.createStudentWithNewParent).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expect.stringMatching(/@no-email\.local$/),
          phone: null,
          relationship: null,
          gender: 'FEMALE',
        }),
        expect.anything(),
      );
    });

    it('hashes the parent default password', async () => {
      await service.create({ studentName: 'A B', parentName: 'C D' }, TUTOR);
      expect(mockedHashData).toHaveBeenCalledWith('Parent@123456');
    });

    it('passes optional student profile fields through, defaulting missing ones to null', async () => {
      await service.create(
        { studentName: 'A B', studentPhone: '0911', gender: 'OTHER', school: 'THPT X' },
        TUTOR,
      );
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({
          phone: '0911',
          gender: 'OTHER',
          school: 'THPT X',
          dateOfBirth: null,
        }),
      );

      await service.create({ studentName: 'A B' }, TUTOR);
      expect(repo.createStudent).toHaveBeenLastCalledWith(
        expect.objectContaining({ phone: null, gender: null, school: null }),
      );
    });

    it('does not create a parent when parentName is an empty string', async () => {
      await service.create({ studentName: 'A B', parentName: '' }, TUTOR);
      expect(repo.createParent).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    const raw = {
      id: STUDENT_ID,
      email: 's@example.com',
      username: 'a_b',
      firstName: 'A',
      lastName: 'B',
      userCode: 'STU1',
      phone: null,
      avatar: null,
      gender: 'MALE',
      dateOfBirth: new Date('2010-05-01T00:00:00.000Z'),
      school: 'X',
      address: null,
      district: null,
      province: null,
      parentId: PARENT_ID,
      role: 'STUDENT',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      parent: {
        id: PARENT_ID,
        firstName: 'Tran',
        lastName: 'Thi C',
        email: 'p@example.com',
        phone: '0900',
        relationship: 'MOTHER',
        userCode: 'PAR1',
        avatar: null,
        address: 'Hanoi',
        district: 'D1',
        province: 'HN',
      },
    };

    it('maps rows, converts dates to ISO and flattens parent fields', async () => {
      repo.getAllStudents.mockResolvedValue({
        students: [raw],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
      const query = { page: 1, limit: 10 } as never;
      const result = await service.findAll(query, ADMIN_ACTOR);

      expect(repo.getAllStudents).toHaveBeenCalledWith({ query });
      expect(result.pagination).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
      expect(result.students[0]).toMatchObject({
        id: STUDENT_ID,
        dateOfBirth: '2010-05-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        parentName: 'Tran Thi C',
        parentPhone: '0900',
        parentEmail: 'p@example.com',
        parentRelationship: 'MOTHER',
        parent: expect.objectContaining({ id: PARENT_ID, userCode: 'PAR1', province: 'HN' }),
      });
    });

    it('attaches joined classes, classCount and the managing tutor summary', async () => {
      repo.getAllStudents.mockResolvedValue({
        students: [
          {
            ...raw,
            tutorId: 'tutor-1',
            tutor: {
              id: 'tutor-1',
              firstName: 'Minh',
              lastName: 'Nguyen',
              userCode: 'T1',
              email: 't@x.com',
              phone: null,
              avatar: null,
              password: 'secret',
            },
          },
        ],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
      repo.findClassesByStudentIds.mockResolvedValue([
        { studentId: STUDENT_ID, id: 'c1', name: 'Toan 1', code: 'TOAN1' },
        { studentId: STUDENT_ID, id: 'c2', name: 'Ly 1', code: 'LY1' },
      ]);
      const { students } = await service.findAll({ page: 1, limit: 10 } as never, ADMIN_ACTOR);
      expect(repo.findClassesByStudentIds).toHaveBeenCalledWith({ studentIds: [STUDENT_ID] });
      expect(students[0]).toMatchObject({
        tutorId: 'tutor-1',
        tutor: { id: 'tutor-1', firstName: 'Minh', lastName: 'Nguyen', userCode: 'T1' },
        classes: [
          { id: 'c1', name: 'Toan 1', code: 'TOAN1' },
          { id: 'c2', name: 'Ly 1', code: 'LY1' },
        ],
        classCount: 2,
      });
      expect(students[0]).not.toHaveProperty('tutor.password');
    });

    it('returns empty classes and a null tutor when the student has none', async () => {
      repo.getAllStudents.mockResolvedValue({
        students: [{ ...raw, tutorId: null, tutor: null }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
      const { students } = await service.findAll({ page: 1, limit: 10 } as never, ADMIN_ACTOR);
      expect(students[0]).toMatchObject({ tutorId: null, tutor: null, classes: [], classCount: 0 });
    });

    it('exposes null parent fields when there is no linked parent', async () => {
      repo.getAllStudents.mockResolvedValue({
        students: [{ ...raw, parentId: null, parent: null }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
      const { students } = await service.findAll({ page: 1, limit: 10 } as never, ADMIN_ACTOR);
      expect(students[0]).toMatchObject({
        parentId: null,
        parentName: null,
        parentPhone: null,
        parentEmail: null,
        parentRelationship: null,
        parent: null,
      });
    });

    it('keeps non-Date date values as-is and stringifies non-Date timestamps', async () => {
      repo.getAllStudents.mockResolvedValue({
        students: [{ ...raw, dateOfBirth: '2010-05-01', createdAt: '2026-01-01', updatedAt: 42 }],
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
      });
      const { students } = await service.findAll({ page: 1, limit: 10 } as never, ADMIN_ACTOR);
      expect(students[0].dateOfBirth).toBe('2010-05-01');
      expect(students[0].createdAt).toBe('2026-01-01');
      expect(students[0].updatedAt).toBe('42');
    });

    it('returns an empty list untouched', async () => {
      const pagination = { total: 0, page: 1, limit: 10, totalPages: 0 };
      repo.getAllStudents.mockResolvedValue({ students: [], pagination });
      await expect(service.findAll({ page: 1, limit: 10 } as never, ADMIN_ACTOR)).resolves.toEqual({
        students: [],
        pagination,
      });
    });
  });

  describe('findById', () => {
    it('throws NotFound when the student does not exist', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.findById(STUDENT_ID, ADMIN_ACTOR)).rejects.toThrow(NotFoundException);
      await expect(service.findById(STUDENT_ID, ADMIN_ACTOR)).rejects.toThrow(
        ERROR_MESSAGES.STUDENT_NOT_FOUND,
      );
    });

    it('returns the full profile with parent nested', async () => {
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        email: 's@example.com',
        username: 'a_b',
        firstName: 'A',
        lastName: 'B',
        userCode: 'STU1',
        phone: null,
        avatar: null,
        gender: null,
        dateOfBirth: null,
        school: null,
        address: 'Addr',
        district: null,
        province: null,
        parentId: PARENT_ID,
        role: 'STUDENT',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        parent: {
          id: PARENT_ID,
          firstName: 'Tran',
          lastName: 'Thi C',
          email: 'p@example.com',
          phone: null,
          relationship: 'FATHER',
          userCode: 'PAR1',
          avatar: null,
          address: null,
          district: null,
          province: null,
        },
      });

      const result = await service.findById(STUDENT_ID, ADMIN_ACTOR);
      expect(repo.findById).toHaveBeenCalledWith({ id: STUDENT_ID });
      expect(result).toMatchObject({
        id: STUDENT_ID,
        address: 'Addr',
        dateOfBirth: null,
        parentName: 'Tran Thi C',
        parentRelationship: 'FATHER',
        parentPhone: null,
        parent: expect.objectContaining({ id: PARENT_ID, relationship: 'FATHER' }),
      });
    });

    it('returns parent: null and null parent scalars when unlinked', async () => {
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        parentId: null,
        parent: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        dateOfBirth: null,
      });
      const result = await service.findById(STUDENT_ID, ADMIN_ACTOR);
      expect(result).toMatchObject({
        parent: null,
        parentName: null,
        parentPhone: null,
        parentEmail: null,
        parentRelationship: null,
      });
    });
  });

  describe('update', () => {
    const existing = {
      id: STUDENT_ID,
      parentId: null as string | null,
      tutorId: TUTOR.id,
      firstName: 'A',
      lastName: 'B',
    };

    beforeEach(() => {
      repo.findById.mockResolvedValue(existing);
      repo.update.mockImplementation(async ({ data }) => ({ ...existing, ...data }));
    });

    it('throws NotFound before writing anything', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.update(STUDENT_ID, { school: 'X' } as never, ADMIN_ACTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
    });

    it('does not touch the DB write path for an empty payload', async () => {
      await service.update(STUDENT_ID, {} as never, ADMIN_ACTOR);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
      expect(repo.createParent).not.toHaveBeenCalled();
    });

    const NEW_TUTOR_ID = '99999999-9999-4999-8999-999999999999';

    it("refuses to move a student who is enrolled in another tutor's class", async () => {
      repo.findTutorById.mockResolvedValueOnce({ id: NEW_TUTOR_ID, role: 'TUTOR' });
      repo.hasEnrollmentWithOtherTutor.mockResolvedValueOnce(true);

      await expect(
        service.update(STUDENT_ID, { tutorId: NEW_TUTOR_ID } as never, ADMIN_ACTOR),
      ).rejects.toThrow(new BadRequestException(ERROR_MESSAGES.CLASS_TUTOR_CONFLICT));
      expect(repo.hasEnrollmentWithOtherTutor).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        tutorId: NEW_TUTOR_ID,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('splits studentName into first/last on update', async () => {
      await service.update(STUDENT_ID, { studentName: 'Le Thi Hong' } as never, ADMIN_ACTOR);
      expect(repo.update).toHaveBeenCalledWith({
        id: STUDENT_ID,
        data: { firstName: 'Thi Hong', lastName: 'Le' },
      });
    });

    it('maps empty-string optional scalars to null but keeps non-empty values', async () => {
      await service.update(
        STUDENT_ID,
        {
          studentPhone: '',
          school: '',
          address: '',
          district: '',
          province: '',
        } as never,
        ADMIN_ACTOR,
      );
      expect(repo.update).toHaveBeenCalledWith({
        id: STUDENT_ID,
        data: { phone: null, school: null, address: null, district: null, province: null },
      });

      await service.update(
        STUDENT_ID,
        { studentPhone: '0999', address: 'Somewhere' } as never,
        ADMIN_ACTOR,
      );
      expect(repo.update).toHaveBeenLastCalledWith({
        id: STUDENT_ID,
        data: { phone: '0999', address: 'Somewhere' },
      });
    });

    it('writes gender, birthday, and avatar (including explicit null avatar)', async () => {
      const birthday = new Date('2011-02-03T00:00:00.000Z');
      await service.update(
        STUDENT_ID,
        { gender: 'FEMALE', birthday, avatar: null } as never,
        ADMIN_ACTOR,
      );
      expect(repo.update).toHaveBeenCalledWith({
        id: STUDENT_ID,
        data: { gender: 'FEMALE', dateOfBirth: birthday, avatar: null },
      });
    });

    it('does not create a parent when parent fields are sent without parentName', async () => {
      await service.update(STUDENT_ID, { parentPhone: '0900' } as never, ADMIN_ACTOR);
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
    });

    it('updates the linked parent row (not the student row) for parent fields', async () => {
      repo.findById.mockResolvedValue({ ...existing, parentId: PARENT_ID });
      await service.update(
        STUDENT_ID,
        {
          parentName: 'Pham Van D',
          parentPhone: '',
          parentEmail: 'new@example.com',
          parentRelationship: 'GUARDIAN',
          parentAddress: '',
          parentDistrict: 'Q1',
          parentProvince: '',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.updateParent).toHaveBeenCalledWith({
        id: PARENT_ID,
        data: {
          firstName: 'Van D',
          lastName: 'Pham',
          phone: null,
          email: 'new@example.com',
          emailVerified: false,
          relationship: 'GUARDIAN',
          address: null,
          district: 'Q1',
          province: null,
        },
      });
      // student row untouched because no student fields were sent
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does not call updateParent when a linked parent receives no effective parent change', async () => {
      repo.findById.mockResolvedValue({ ...existing, parentId: PARENT_ID });
      await service.update(
        STUDENT_ID,
        { parentName: undefined, parentPhone: undefined } as never,
        ADMIN_ACTOR,
      );
      expect(repo.updateParent).not.toHaveBeenCalled();
    });

    it('creates a parent and links it when none exists yet', async () => {
      mockedGenerateCode.mockReturnValueOnce('PARNEW');
      await service.update(
        STUDENT_ID,
        {
          parentName: 'Vu Thi E',
          parentRelationship: 'MOTHER',
          parentPhone: '0988',
          parentAddress: '1 Street',
          parentDistrict: 'D',
          parentProvince: 'P',
        } as never,
        ADMIN_ACTOR,
      );

      // Parent and link are one transaction (no orphan PARENT if the link fails).
      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({
          firstName: 'Thi E',
          lastName: 'Vu',
          userCode: 'PARNEW',
          relationship: 'MOTHER',
          gender: 'FEMALE',
          phone: '0988',
          // users.email is UNIQUE: a parent without an email gets a placeholder, never ''.
          email: expect.stringMatching(/@no-email\.local$/),
          tutorId: TUTOR.id,
          address: '1 Street',
          district: 'D',
          province: 'P',
        }),
      });
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
    });

    it('stores null address fields for a newly created parent when none are given', async () => {
      await service.update(STUDENT_ID, { parentName: 'Vu Thi E' } as never, ADMIN_ACTOR);
      expect(repo.updateParent).not.toHaveBeenCalled();
      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ address: null, district: null, province: null }),
      });
    });

    it('does nothing for parent fields when unlinked and parentName is empty', async () => {
      await service.update(
        STUDENT_ID,
        { parentName: '', parentPhone: '0900' } as never,
        ADMIN_ACTOR,
      );
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns the updated row from repo.update', async () => {
      repo.update.mockResolvedValueOnce({ id: STUDENT_ID, school: 'Z' });
      await expect(
        service.update(STUDENT_ID, { school: 'Z' } as never, ADMIN_ACTOR),
      ).resolves.toEqual({
        id: STUDENT_ID,
        school: 'Z',
      });
    });

    it('falls back to the pre-update row when repo.update returns null', async () => {
      repo.update.mockResolvedValueOnce(null);
      await expect(
        service.update(STUDENT_ID, { school: 'Z' } as never, ADMIN_ACTOR),
      ).resolves.toEqual(existing);
    });
  });

  describe('branch coverage: findById dates and parent edits', () => {
    const linked = {
      id: STUDENT_ID,
      parentId: PARENT_ID,
      tutorId: TUTOR.id,
      firstName: 'A',
      lastName: 'B',
    };

    beforeEach(() => {
      repo.update.mockImplementation(async ({ data }) => ({ ...linked, ...data }));
    });

    it('findById passes string dates through and stringifies non-Date timestamps', async () => {
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        email: 's@example.com',
        username: 'stu',
        firstName: 'A',
        lastName: 'B',
        userCode: 'C1',
        phone: null,
        avatar: null,
        gender: 'MALE',
        dateOfBirth: '2010-05-01',
        school: null,
        address: null,
        district: null,
        province: null,
        parentId: null,
        parent: null,
        role: 'STUDENT',
        isActive: true,
        createdAt: '2026-01-01',
        updatedAt: 42,
      });

      const result = await service.findById(STUDENT_ID, ADMIN_ACTOR);

      expect(result.dateOfBirth).toBe('2010-05-01');
      expect(result.createdAt).toBe('2026-01-01');
      expect(result.updatedAt).toBe('42');
    });

    it('keeps a null dateOfBirth as null in the findById profile', async () => {
      repo.findById.mockResolvedValue({
        ...linked,
        email: 's@example.com',
        username: 'stu',
        userCode: 'C1',
        dateOfBirth: null,
        parent: null,
        role: 'STUDENT',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      });

      const result = await service.findById(STUDENT_ID, ADMIN_ACTOR);

      expect(result.dateOfBirth).toBeNull();
      expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('writes null for a blank new-parent address while keeping the district', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });

      await service.update(
        STUDENT_ID,
        {
          parentName: 'Vu Thi E',
          parentAddress: '',
          parentDistrict: 'D',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ address: null, district: 'D', province: null }),
      });
    });

    it('falls back to the pre-update student row when the parent link write returns nothing', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });
      repo.createParentAndLinkStudent.mockResolvedValue(undefined);

      const result = await service.update(
        STUDENT_ID,
        { parentName: 'Vu Thi E' } as never,
        ADMIN_ACTOR,
      );

      expect(result).toEqual({ ...linked, parentId: null });
    });

    it('serializes a Date dateOfBirth to ISO on findById', async () => {
      repo.findById.mockResolvedValue({
        ...linked,
        email: 's@example.com',
        username: 'stu',
        userCode: 'C1',
        dateOfBirth: new Date('2010-05-01T00:00:00Z'),
        parent: null,
        role: 'STUDENT',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      });

      const result = await service.findById(STUDENT_ID, ADMIN_ACTOR);

      expect(result.dateOfBirth).toBe('2010-05-01T00:00:00.000Z');
    });

    it('nulls blank district and province for a new parent while keeping a filled address', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });

      await service.update(
        STUDENT_ID,
        {
          parentName: 'Vu Thi E',
          parentAddress: '1 Street',
          parentDistrict: '',
          parentProvince: '',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ address: '1 Street', district: null, province: null }),
      });
    });

    it('clears a linked parent district when an empty string is sent', async () => {
      repo.findById.mockResolvedValue(linked);

      await service.update(STUDENT_ID, { parentDistrict: '' } as never, ADMIN_ACTOR);

      expect(repo.updateParent).toHaveBeenCalledWith({
        id: PARENT_ID,
        data: { district: null },
      });
    });

    it('stores MALE for a newly created FATHER parent', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });

      await service.update(
        STUDENT_ID,
        {
          parentName: 'Tran Van F',
          parentRelationship: 'FATHER',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ gender: 'MALE' }),
      });
    });

    it('writes only the provided address fields (others null) on a newly created parent', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });

      await service.update(
        STUDENT_ID,
        { parentName: 'Vu Thi E', parentDistrict: 'D' } as never,
        ADMIN_ACTOR,
      );

      expect(repo.createParentAndLinkStudent).toHaveBeenCalledWith({
        studentId: STUDENT_ID,
        parent: expect.objectContaining({ address: null, district: 'D', province: null }),
      });
    });
  });

  describe('parentId linking', () => {
    const PARENT_ID = '3f0c9a7e-2b1d-4c5e-8f6a-7b8c9d0e1f2a';
    const parentRow = { id: PARENT_ID, role: 'PARENT', firstName: 'Tran', lastName: 'Thi B' };

    it('create links the existing parent and creates no new PARENT', async () => {
      repo.findParentForActor.mockResolvedValue(parentRow);
      await service.create({ studentName: 'A B', parentId: PARENT_ID } as never, TUTOR);
      expect(repo.findParentForActor).toHaveBeenCalledWith({
        id: PARENT_ID,
        ownerTutorId: TUTOR.id,
      });
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: PARENT_ID }),
      );
    });

    it('create throws NotFound when the parentId is not a PARENT', async () => {
      repo.findParentForActor.mockResolvedValue(null);
      await expect(
        service.create({ studentName: 'A B', parentId: PARENT_ID } as never, TUTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('update re-links the student only and leaves the parent record untouched', async () => {
      repo.findById.mockResolvedValue({ id: STUDENT_ID, parentId: null, tutorId: TUTOR.id });
      repo.findParentForActor.mockResolvedValue(parentRow);
      repo.update.mockImplementation(async ({ data }) => ({ id: STUDENT_ID, ...data }));
      const result = await service.update(
        STUDENT_ID,
        { parentId: PARENT_ID } as never,
        ADMIN_ACTOR,
      );
      expect(repo.update).toHaveBeenCalledWith({ id: STUDENT_ID, data: { parentId: PARENT_ID } });
      expect(repo.updateParent).not.toHaveBeenCalled();
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ parentId: PARENT_ID }));
    });

    it('update throws NotFound before writing when the parentId is not a PARENT', async () => {
      repo.findById.mockResolvedValue({ id: STUDENT_ID, parentId: null, tutorId: TUTOR.id });
      repo.findParentForActor.mockResolvedValue(null);
      await expect(
        service.update(STUDENT_ID, { parentId: PARENT_ID } as never, ADMIN_ACTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('tutor cannot edit an existing parent', () => {
    const PARENT_ID = '3f0c9a7e-2b1d-4c5e-8f6a-7b8c9d0e1f2a';
    const withParent = {
      id: STUDENT_ID,
      parentId: PARENT_ID,
      tutorId: TUTOR.id,
      parent: { id: PARENT_ID, email: 'old@example.com' },
    };

    it('TUTOR sending parent fields for a student that already has a parent gets 403', async () => {
      repo.findById.mockResolvedValue(withParent);
      await expect(
        service.update(STUDENT_ID, { parentEmail: 'attacker@example.com' } as never, TUTOR),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.updateParent).not.toHaveBeenCalled();
    });

    it('TUTOR cannot re-link to a parent outside their scope (404, nothing written)', async () => {
      repo.findById.mockResolvedValue({ ...withParent, parentId: null, parent: null });
      repo.findParentForActor.mockResolvedValue(null);
      await expect(
        service.update(STUDENT_ID, { parentId: PARENT_ID } as never, TUTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.findParentForActor).toHaveBeenCalledWith({
        id: PARENT_ID,
        ownerTutorId: TUTOR.id,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('ADMIN changing the parent email re-verifies it and ends the parent sessions', async () => {
      repo.findById.mockResolvedValue(withParent);
      repo.findUserByEmail.mockResolvedValue(null);
      await service.update(STUDENT_ID, { parentEmail: 'new@example.com' } as never, ADMIN_ACTOR);
      expect(repo.updateParent).toHaveBeenCalledWith({
        id: PARENT_ID,
        data: { email: 'new@example.com', emailVerified: false },
      });
      expect(rmq.send).toHaveBeenCalledWith('redis.delByPrefix', {
        prefix: `session:${PARENT_ID}:`,
      });
    });

    it('ADMIN cannot move the parent to an email another account already uses', async () => {
      repo.findById.mockResolvedValue(withParent);
      repo.findUserByEmail.mockResolvedValue({ id: 'other', role: 'STUDENT', tutorId: null });
      await expect(
        service.update(STUDENT_ID, { parentEmail: 'taken@example.com' } as never, ADMIN_ACTOR),
      ).rejects.toThrow(BadRequestException);
      expect(repo.updateParent).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('throws NotFound when the student does not exist and deletes nothing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.delete(STUDENT_ID, ADMIN_ACTOR)).rejects.toThrow(NotFoundException);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('deletes the student and returns its id', async () => {
      repo.findById.mockResolvedValue({ id: STUDENT_ID });
      repo.delete.mockResolvedValue(true);
      await expect(service.delete(STUDENT_ID, ADMIN_ACTOR)).resolves.toEqual({ id: STUDENT_ID });
      expect(repo.delete).toHaveBeenCalledWith({ id: STUDENT_ID });
    });

    it('revokes every session of the deleted student', async () => {
      repo.findById.mockResolvedValue({ id: STUDENT_ID });
      repo.delete.mockResolvedValue(true);
      await service.delete(STUDENT_ID, ADMIN_ACTOR);
      const patterns = rmq.send.mock.calls.map((c) => c[0]);
      expect(patterns).toEqual(['redis.set', 'redis.delByPrefix', 'redis.delByPrefix']);
      expect(rmq.send).toHaveBeenCalledWith('redis.delByPrefix', {
        prefix: `session:${STUDENT_ID}:`,
      });
    });
  });

  describe('students sharing one parent', () => {
    const OTHER_TUTOR_ID = '99999999-9999-4999-8999-999999999999';
    const unlinked = {
      id: STUDENT_ID,
      tutorId: TUTOR.id,
      parentId: null,
      parent: null,
      tutor: null,
    };

    it('gives every parent created without an email its own placeholder (no shared "")', async () => {
      repo.findById.mockResolvedValue(unlinked);
      await service.update(STUDENT_ID, { parentName: 'Vu Thi E' } as never, ADMIN_ACTOR);
      await service.update(STUDENT_ID, { parentName: 'Le Van G' } as never, ADMIN_ACTOR);
      const emails = repo.createParentAndLinkStudent.mock.calls.map((c) => c[0].parent.email);
      expect(emails[0]).toMatch(/@no-email\.local$/);
      expect(emails[1]).toMatch(/@no-email\.local$/);
      expect(emails[0]).not.toBe(emails[1]);
    });

    it("create: links the tutor's existing PARENT with the same email instead of a new account", async () => {
      repo.findUserByEmail.mockResolvedValue({ id: PARENT_ID, role: 'PARENT', tutorId: TUTOR.id });
      await service.create(
        { studentName: 'Nguyen Van B', parentName: 'Tran Thi B', parentEmail: 'mom@example.com' },
        TUTOR,
      );
      expect(repo.createStudentWithNewParent).not.toHaveBeenCalled();
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: PARENT_ID }),
      );
    });

    it('create: an ADMIN may reuse any PARENT by email', async () => {
      repo.findUserByEmail.mockResolvedValue({
        id: PARENT_ID,
        role: 'PARENT',
        tutorId: OTHER_TUTOR_ID,
      });
      repo.findTutorById.mockResolvedValue({ id: TUTOR.id });
      await service.create(
        {
          studentName: 'Nguyen Van B',
          tutorId: TUTOR.id,
          parentName: 'Tran Thi B',
          parentEmail: 'mom@example.com',
        },
        ADMIN_ACTOR,
      );
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: PARENT_ID }),
      );
    });

    it.each([
      [
        "another tutor's PARENT",
        { id: PARENT_ID, role: 'PARENT', tutorId: '99999999-9999-4999-8999-999999999999' },
      ],
      ['a non-PARENT account', { id: PARENT_ID, role: 'TUTOR', tutorId: null }],
    ])('create: a parent email held by %s is a field-level duplicate', async (_n, holder) => {
      repo.findUserByEmail.mockResolvedValue(holder);
      await expect(
        service.create(
          {
            studentName: 'Nguyen Van B',
            parentName: 'Tran Thi B',
            parentEmail: 'taken@example.com',
          },
          TUTOR,
        ),
      ).rejects.toMatchObject({
        response: {
          errors: [expect.objectContaining({ field: 'parentEmail', code: 'duplicate' })],
        },
      });
      expect(repo.createStudent).not.toHaveBeenCalled();
      expect(repo.createStudentWithNewParent).not.toHaveBeenCalled();
    });

    it('update: links an unlinked student to the existing PARENT with that email', async () => {
      repo.findById.mockResolvedValue(unlinked);
      repo.findUserByEmail.mockResolvedValue({ id: PARENT_ID, role: 'PARENT', tutorId: TUTOR.id });
      repo.update.mockResolvedValue({ id: STUDENT_ID, parentId: PARENT_ID });
      await service.update(
        STUDENT_ID,
        { parentName: 'Tran Thi B', parentEmail: 'mom@example.com' } as never,
        ADMIN_ACTOR,
      );
      expect(repo.createParentAndLinkStudent).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ id: STUDENT_ID, data: { parentId: PARENT_ID } });
    });

    describe('findParents (parent picker)', () => {
      it('scopes a TUTOR to their own parents and hides placeholder emails', async () => {
        repo.getParents.mockResolvedValue({
          parents: [
            {
              id: PARENT_ID,
              email: 'tran@no-email.local',
              firstName: 'B',
              lastName: 'Tran',
              phone: null,
              avatar: null,
              role: 'PARENT',
              isActive: true,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
          total: 1,
        });
        const result = await service.findParents({ page: 1, limit: 20, search: 'tran' }, TUTOR);
        expect(repo.getParents).toHaveBeenCalledWith(
          expect.objectContaining({ ownerTutorId: TUTOR.id, search: 'tran' }),
        );
        expect(result.parents[0].email).toBeNull();
        expect(result.parents[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
        expect(result.pagination).toEqual({ total: 1, page: 1, limit: 20, totalPages: 1 });
      });

      it('lets an ADMIN list every parent', async () => {
        await service.findParents({ page: 1, limit: 20 }, ADMIN_ACTOR);
        expect(repo.getParents).toHaveBeenCalledWith(
          expect.objectContaining({ ownerTutorId: undefined }),
        );
      });

      it('refuses a PARENT or STUDENT caller', async () => {
        await expect(
          service.findParents({ page: 1, limit: 20 }, { id: PARENT_ID, role: 'PARENT' }),
        ).rejects.toThrow();
        expect(repo.getParents).not.toHaveBeenCalled();
      });
    });
  });

  describe('atomic student edit and duplicate email', () => {
    it('writes the student fields, the new parent and the link in one applyStudentUpdate call', async () => {
      mockedGenerateCode.mockReturnValueOnce('PARNEW');
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        parentId: null,
        tutorId: TUTOR.id,
        parent: null,
        tutor: null,
      });
      await service.update(
        STUDENT_ID,
        { studentName: 'Le Van C', parentName: 'Vu Thi E', parentRelationship: 'MOTHER' } as never,
        ADMIN_ACTOR,
      );
      expect(repo.applyStudentUpdate).toHaveBeenCalledTimes(1);
      expect(repo.applyStudentUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          studentId: STUDENT_ID,
          studentData: expect.objectContaining({ firstName: 'Van C', lastName: 'Le' }),
          newParent: expect.objectContaining({ firstName: 'Thi E', relationship: 'MOTHER' }),
        }),
      );
    });

    it('writes nothing when a later check fails (a bad parent id is refused before any write)', async () => {
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        parentId: null,
        tutorId: TUTOR.id,
        parent: null,
        tutor: null,
      });
      repo.findParentForActor.mockResolvedValue(null);
      await expect(
        service.update(
          STUDENT_ID,
          { studentName: 'Le Van C', parentId: PARENT_ID } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(repo.applyStudentUpdate).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('surfaces a failed transaction and does not revoke sessions for a write that never landed', async () => {
      repo.findById.mockResolvedValue({
        id: STUDENT_ID,
        parentId: PARENT_ID,
        tutorId: TUTOR.id,
        parent: { id: PARENT_ID, email: 'old@example.com' },
        tutor: null,
      });
      repo.applyStudentUpdate.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.update(STUDENT_ID, { parentEmail: 'new@example.com' } as never, ADMIN_ACTOR),
      ).rejects.toThrow('db down');
      expect(rmq.send).not.toHaveBeenCalledWith('redis.delByPrefix', expect.anything());
    });

    it('refuses a student email that is already taken, before the insert', async () => {
      repo.findTutorById.mockResolvedValueOnce({ id: TUTOR.id });
      repo.findUserByEmail.mockResolvedValueOnce({ id: 'other', role: 'STUDENT', tutorId: null });
      await expect(
        service.create(
          { studentName: 'Le Van A', tutorId: TUTOR.id, email: 'taken@example.com' } as never,
          ADMIN_ACTOR,
        ),
      ).rejects.toMatchObject({ message: ERROR_MESSAGES.ACCOUNT_ALREADY_EXISTS });
      expect(repo.createStudent).not.toHaveBeenCalled();
      expect(repo.createStudentWithNewParent).not.toHaveBeenCalled();
    });
  });
});
