import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from 'src/features/user/user.service';
import type { UserRepository } from 'src/features/user/user.repository';
import { hashData } from '@packages/helpers';

const SID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('mustChangePassword on staff-created accounts and self-service change', () => {
  let service: UserService;
  let repo: Record<string, jest.Mock>;
  let rmq: { send: jest.Mock; emit: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findByField: jest.fn().mockResolvedValue([]),
      findUserCode: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(async (data: Record<string, unknown>) => ({ ...data })),
      updatePassword: jest.fn().mockResolvedValue({ id: USER_ID }),
      findWithPassword: jest.fn(),
    };
    rmq = { send: jest.fn().mockResolvedValue({ deleted: 0 }), emit: jest.fn() };
    service = new UserService(repo as unknown as UserRepository, rmq as never, new JwtService({}), {
      get: (key: string) => ({ JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'r' })[key],
    } as never);
  });

  afterEach(() => jest.restoreAllMocks());

  const base = { email: 'new@example.test', firstName: 'Bao', lastName: 'Tran' };

  it.each([
    ['STUDENT', true],
    ['TUTOR', true],
    ['PARENT', false],
  ])('actor-created %s sets mustChangePassword=%s', async (role, expected) => {
    await service.createUserService({ ...base, role, password: 'Plain-1234' } as never, {
      sendCredentials: true,
    });
    expect(repo.create.mock.calls[0][0].mustChangePassword).toBe(expected);
  });

  it('self sign-up (no sendCredentials option) never sets the flag', async () => {
    await service.createUserService({ ...base, role: 'STUDENT', password: 'Plain-1234' } as never);
    expect(repo.create.mock.calls[0][0].mustChangePassword).toBe(false);
  });

  it('rejects a new password equal to the current one', async () => {
    const password = 'Old-Pass-123';
    repo.findWithPassword.mockResolvedValue({ id: USER_ID, password: await hashData(password) });

    await expect(
      service.changePasswordService(
        USER_ID,
        { currentPassword: password, newPassword: password } as never,
        SID,
      ),
    ).rejects.toMatchObject({ message: expect.any(String) });
    expect(repo.updatePassword).not.toHaveBeenCalled();
  });
});
