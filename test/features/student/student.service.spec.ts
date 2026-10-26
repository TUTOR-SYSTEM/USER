import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ERROR_MESSAGES } from 'src/data/constants';
import { StudentService } from 'src/features/student/student.service';
import { StudentRepository } from 'src/features/student/student.repository';
import { generateCode, generateRandomPassword, hashData } from '@packages/helpers';
import type { JwtGuardUser } from 'src/packages/guards/jwt-auth.guard';

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
  let repo: {
    getStudentByField: jest.Mock;
    createParent: jest.Mock;
    createStudent: jest.Mock;
    getAllStudents: jest.Mock;
    findById: jest.Mock;
    update: jest.Mock;
    updateParent: jest.Mock;
    findParentById: jest.Mock;
    delete: jest.Mock;
    usernameExists: jest.Mock;
  };

  const build = async (usernameRows: DbRows[] = []) => {
    // create() generates the student's default password first, then the parent's.
    mockedRandomPassword.mockReset();
    mockedRandomPassword.mockReturnValueOnce('Student@123456').mockReturnValueOnce('Parent@123456');
    repo = {
      getStudentByField: jest.fn().mockResolvedValue(undefined),
      createParent: jest.fn().mockImplementation(async (d) => ({ ...d, id: d.id })),
      createStudent: jest.fn().mockImplementation(async (d) => ({ ...d })),
      getAllStudents: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
      updateParent: jest.fn(),
      findParentById: jest.fn(),
      delete: jest.fn(),
      usernameExists: makeUsernameExists(usernameRows),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [StudentService, { provide: StudentRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(StudentService);
  };

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

    it('rejects an explicit userCode that is already taken, without inserting', async () => {
      repo.getStudentByField.mockResolvedValueOnce({ id: 'someone' });
      await expect(service.create({ ...baseDto, userCode: 'STU001' }, TUTOR)).rejects.toThrow(
        `${ERROR_MESSAGES.STUDENT_CODE_EXISTS}: STU001`,
      );
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

    it('splits the full name on the first space', async () => {
      await service.create({ studentName: 'Nguyen Van A' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ firstName: 'Nguyen', lastName: 'Van A' }),
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
      // firstName = "Nguyễn", lastName = "Văn Ánh" -> "Văn Ánh" + "Nguyễn" -> ascii
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'van_anhnguyen' }),
      );
    });

    it('appends _1, _2 ... while the username is taken', async () => {
      // first candidate taken, second free (base is lastName+firstName = 'Van ANguyen')
      await build([[{ id: 'taken' }], []]);
      await service.create({ studentName: 'Nguyen Van A' }, TUTOR);
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ username: 'van_anguyen_1' }),
      );
    });

    it('throws Conflict when all 10 username candidates are taken', async () => {
      await build(Array.from({ length: 10 }, () => [{ id: 'taken' }]));
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
        expect.objectContaining({ email: 'van_anguyen@no-email.local' }),
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

      expect(repo.createParent).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'Tran',
          lastName: 'Thi B',
          email: 'parent@example.com',
          phone: '0900000000',
          relationship: 'MOTHER',
          gender: 'FEMALE',
          userCode: 'PARCODE',
          tutorId: TUTOR.id,
          password: 'hashed:Parent@123456',
        }),
      );
      expect(repo.createStudent).toHaveBeenCalledWith(
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
      expect(repo.createParent).toHaveBeenCalledWith(expect.objectContaining({ gender }));
    });

    it('defaults parent email to empty string and phone/relationship to null', async () => {
      await service.create({ studentName: 'A B', parentName: 'C D' }, TUTOR);
      expect(repo.createParent).toHaveBeenCalledWith(
        expect.objectContaining({ email: '', phone: null, relationship: null, gender: 'FEMALE' }),
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

    it('splits studentName into first/last on update', async () => {
      await service.update(STUDENT_ID, { studentName: 'Le Thi Hong' } as never, ADMIN_ACTOR);
      expect(repo.update).toHaveBeenCalledWith({
        id: STUDENT_ID,
        data: { firstName: 'Le', lastName: 'Thi Hong' },
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
          firstName: 'Pham',
          lastName: 'Van D',
          phone: null,
          email: 'new@example.com',
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
      repo.createParent.mockResolvedValue({ id: 'new-parent-id' });
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

      expect(repo.createParent).toHaveBeenCalledWith(
        expect.objectContaining({
          firstName: 'Vu',
          lastName: 'Thi E',
          userCode: 'PARNEW',
          relationship: 'MOTHER',
          gender: 'FEMALE',
          phone: '0988',
          email: '',
          tutorId: TUTOR.id,
        }),
      );
      expect(repo.updateParent).toHaveBeenCalledWith({
        id: 'new-parent-id',
        data: { address: '1 Street', district: 'D', province: 'P' },
      });
      expect(repo.update).toHaveBeenCalledWith({
        id: STUDENT_ID,
        data: { parentId: 'new-parent-id' },
      });
    });

    it('skips the address write for a newly created parent when no address fields are given', async () => {
      repo.createParent.mockResolvedValue({ id: 'p2' });
      await service.update(STUDENT_ID, { parentName: 'Vu Thi E' } as never, ADMIN_ACTOR);
      expect(repo.updateParent).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalledWith({ id: STUDENT_ID, data: { parentId: 'p2' } });
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
      repo.createParent.mockResolvedValue({ id: 'new-parent-2' });

      await service.update(
        STUDENT_ID,
        {
          parentName: 'Vu Thi E',
          parentAddress: '',
          parentDistrict: 'D',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.updateParent).toHaveBeenCalledWith({
        id: 'new-parent-2',
        data: { address: null, district: 'D', province: null },
      });
    });

    it('falls back to the pre-update student row when the parent link write returns nothing', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });
      repo.createParent.mockResolvedValue({ id: 'new-parent-3' });
      repo.update.mockResolvedValue(undefined);

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
      repo.createParent.mockResolvedValue({ id: 'new-parent-4' });

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

      expect(repo.updateParent).toHaveBeenCalledWith({
        id: 'new-parent-4',
        data: { address: '1 Street', district: null, province: null },
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
      repo.createParent.mockResolvedValue({ id: 'new-father' });

      await service.update(
        STUDENT_ID,
        {
          parentName: 'Tran Van F',
          parentRelationship: 'FATHER',
        } as never,
        ADMIN_ACTOR,
      );

      expect(repo.createParent).toHaveBeenCalledWith(expect.objectContaining({ gender: 'MALE' }));
    });

    it('writes only the provided address fields (others null) on a newly created parent', async () => {
      repo.findById.mockResolvedValue({ ...linked, parentId: null });
      repo.createParent.mockResolvedValue({ id: 'new-parent' });

      await service.update(
        STUDENT_ID,
        { parentName: 'Vu Thi E', parentDistrict: 'D' } as never,
        ADMIN_ACTOR,
      );

      expect(repo.updateParent).toHaveBeenCalledWith({
        id: 'new-parent',
        data: { address: null, district: 'D', province: null },
      });
    });
  });

  describe('parentId linking', () => {
    const PARENT_ID = '3f0c9a7e-2b1d-4c5e-8f6a-7b8c9d0e1f2a';
    const parentRow = { id: PARENT_ID, role: 'PARENT', firstName: 'Tran', lastName: 'Thi B' };

    it('create links the existing parent and creates no new PARENT', async () => {
      repo.findParentById.mockResolvedValue(parentRow);
      await service.create({ studentName: 'A B', parentId: PARENT_ID } as never, TUTOR);
      expect(repo.findParentById).toHaveBeenCalledWith({ id: PARENT_ID });
      expect(repo.createParent).not.toHaveBeenCalled();
      expect(repo.createStudent).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: PARENT_ID }),
      );
    });

    it('create throws NotFound when the parentId is not a PARENT', async () => {
      repo.findParentById.mockResolvedValue(null);
      await expect(
        service.create({ studentName: 'A B', parentId: PARENT_ID } as never, TUTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.createStudent).not.toHaveBeenCalled();
    });

    it('update re-links the student only and leaves the parent record untouched', async () => {
      repo.findById.mockResolvedValue({ id: STUDENT_ID, parentId: null, tutorId: TUTOR.id });
      repo.findParentById.mockResolvedValue(parentRow);
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
      repo.findParentById.mockResolvedValue(null);
      await expect(
        service.update(STUDENT_ID, { parentId: PARENT_ID } as never, ADMIN_ACTOR),
      ).rejects.toThrow(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
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
  });
});
