import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { StudentService } from 'src/features/student/student.service';
import { StudentRepository } from 'src/features/student/student.repository';
import { RmqProducer } from 'src/features/rabbitmq/rmq.producer';
import type { JwtGuardUser } from 'src/packages/guards/jwt-auth.guard';

const ADMIN_ACTOR = { id: '55555555-5555-4555-8555-555555555555', role: 'ADMIN' as const };
const TUTOR: JwtGuardUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'tutor@example.com',
  typ: 'access',
  role: 'TUTOR',
};
const PARENT_ID = '44444444-4444-4444-8444-444444444444';

const mailCalls = (rmq: { send: jest.Mock }) =>
  rmq.send.mock.calls.filter(([pattern]) => pattern === 'email.sendAccountCreated');

describe('StudentService.create — account-created mails', () => {
  let service: StudentService;
  let rmq: { send: jest.Mock; emit: jest.Mock };
  let repo: Record<string, jest.Mock>;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      getStudentByField: jest.fn().mockResolvedValue(undefined),
      createStudent: jest.fn().mockImplementation(async (d) => ({ ...d })),
      createStudentWithNewParent: jest.fn().mockImplementation(async (_p, s) => ({ ...s })),
      findUserByEmail: jest.fn().mockResolvedValue(null),
      findParentForActor: jest.fn().mockResolvedValue({ id: PARENT_ID }),
      findTutorById: jest.fn(),
      usernameExists: jest.fn().mockResolvedValue(false),
    };
    rmq = { send: jest.fn().mockResolvedValue(undefined), emit: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        StudentService,
        { provide: StudentRepository, useValue: repo },
        { provide: RmqProducer, useValue: rmq },
      ],
    }).compile();
    service = moduleRef.get(StudentService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('mails the student and a newly created parent with their own plaintext passwords', async () => {
    await service.create(
      {
        studentName: 'Nguyen Van A',
        email: 'student@x.dev',
        password: 'Student-Pass-1',
        parentName: 'Tran Thi B',
        parentEmail: 'parent@x.dev',
        parentPassword: 'Parent-Pass-2',
      } as never,
      TUTOR,
    );

    const calls = mailCalls(rmq);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      to: 'parent@x.dev',
      email: 'parent@x.dev',
      password: 'Parent-Pass-2',
    });
    expect(calls[1][1]).toMatchObject({
      to: 'student@x.dev',
      email: 'student@x.dev',
      password: 'Student-Pass-1',
    });
  });

  it('flags the student and a typed-password parent, but not a generated-password parent, as mustChangePassword', async () => {
    await service.create(
      {
        studentName: 'Nguyen Van A',
        email: 'student@x.dev',
        password: 'Student-Pass-1',
        parentName: 'Tran Thi B',
        parentEmail: 'parent@x.dev',
        parentPassword: 'Parent-Pass-2',
      } as never,
      TUTOR,
    );
    expect(repo.createStudentWithNewParent.mock.calls[0][1].mustChangePassword).toBe(true);
    expect(repo.createStudentWithNewParent.mock.calls[0][0].mustChangePassword).toBe(false);

    await service.create(
      {
        studentName: 'Le Van C',
        email: 'c@x.dev',
        password: 'Student-Pass-3',
        parentName: 'Pham Thi D',
        parentEmail: 'd@x.dev',
      } as never,
      TUTOR,
    );
    expect(repo.createStudentWithNewParent.mock.calls[1][0].mustChangePassword).toBe(true);
  });

  it('does not mail the placeholder address of a student created without email', async () => {
    await service.create(
      { studentName: 'Nguyen Van A', password: 'Student-Pass-1' } as never,
      TUTOR,
    );
    expect(mailCalls(rmq)).toHaveLength(0);
  });

  it('does not mail an existing parent linked by parentId', async () => {
    await service.create(
      {
        studentName: 'Nguyen Van A',
        email: 'student@x.dev',
        password: 'Student-Pass-1',
        parentId: PARENT_ID,
      } as never,
      TUTOR,
    );

    const calls = mailCalls(rmq);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ to: 'student@x.dev' });
  });

  it('still creates the student when the mail RPC fails', async () => {
    rmq.send.mockRejectedValue(Object.assign(new Error('rmq down'), { name: 'RpcError' }));
    await expect(
      service.create(
        {
          studentName: 'Nguyen Van A',
          email: 'student@x.dev',
          password: 'Student-Pass-1',
        } as never,
        TUTOR,
      ),
    ).resolves.toMatchObject({ email: 'student@x.dev' });
    expect(repo.createStudent).toHaveBeenCalledTimes(1);
  });
});
