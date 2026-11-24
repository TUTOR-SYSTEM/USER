import { Logger } from '@nestjs/common';
import { managedPasswordSchema } from '@packages/entities/auth/password.schema';
import { AdminService } from 'src/features/admin/admin.service';
import type { AdminRepository } from 'src/features/admin/admin.repository';

jest.mock('src/features/admin/admin.repository', () => ({
  AdminRepository: class AdminRepository {},
}));

const ADMIN_ACTOR = { id: '0b9e7d1a-2c3f-4a5b-9c8d-7e6f5a4b3c2d', role: 'ADMIN' };
const CREATED_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';

describe('AdminService create — account-created mails', () => {
  let service: AdminService;
  let rmq: { send: jest.Mock; emit: jest.Mock };
  let repo: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findByEmail: jest.fn().mockResolvedValue([]),
      findByUsername: jest.fn().mockResolvedValue([]),
      findByUserCode: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async (d) => ({ ...d, id: CREATED_ID, subjects: null })),
    };
    rmq = { send: jest.fn().mockResolvedValue(undefined), emit: jest.fn() };
    service = new AdminService(repo as unknown as AdminRepository, rmq as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const mailCalls = () =>
    rmq.send.mock.calls.filter(([pattern]) => pattern === 'email.sendAccountCreated');

  const dto = {
    email: 'Tutor.New@Tutor.dev',
    firstName: 'Bao',
    lastName: 'Tran',
    password: 'Managed-Pass-1',
  };

  it('mails the tutor once with the given password, after the account is written', async () => {
    await service.createTutor(dto as never, ADMIN_ACTOR);

    expect(repo.create).toHaveBeenCalledTimes(1);
    const calls = mailCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({
      to: 'tutor.new@tutor.dev',
      password: 'Managed-Pass-1',
    });
  });

  it('marks admin-created accounts as mustChangePassword', async () => {
    await service.createTutor(dto as never, ADMIN_ACTOR);
    await service.createStudent({ ...dto, email: 'stu2@x.dev' } as never, ADMIN_ACTOR);
    expect(repo.create.mock.calls.map((c) => c[0].mustChangePassword)).toEqual([true, true]);
  });

  it('mails a student created by admin exactly once', async () => {
    await service.createStudent({ ...dto, email: 'stu@x.dev' } as never, ADMIN_ACTOR);
    expect(mailCalls()).toHaveLength(1);
    expect(mailCalls()[0][1]).toMatchObject({ to: 'stu@x.dev' });
  });

  it('mails a generated password (not the hash) when the admin leaves it empty', async () => {
    await service.createStudent({ ...dto, password: undefined } as never, ADMIN_ACTOR);
    const sent = mailCalls()[0][1] as { password: string };
    expect(sent.password).toHaveLength(10);
    expect(managedPasswordSchema.safeParse(sent.password).success).toBe(true);
    expect(repo.create.mock.calls[0][0].password).not.toBe(sent.password);
  });

  it('still returns the created account when the mail RPC fails', async () => {
    rmq.send.mockRejectedValue(Object.assign(new Error('down'), { name: 'TimeoutError' }));
    await expect(service.createTutor(dto as never, ADMIN_ACTOR)).resolves.toMatchObject({
      id: CREATED_ID,
    });
  });
});
