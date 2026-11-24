import { Logger } from '@nestjs/common';
import {
  sendAccountCreatedMail,
  type AccountMailClient,
} from '../../../src/packages/helpers/account-mail.helper';

const input = {
  userId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  email: 'lan@tutor.dev',
  username: 'lan.nguyen',
  displayName: 'Lan',
  password: 'Secret-Pass-999',
};

describe('sendAccountCreatedMail', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends email.sendAccountCreated with the credentials', async () => {
    const send = jest.fn().mockResolvedValue({ id: 'm1' });
    await sendAccountCreatedMail({ send } as unknown as AccountMailClient, input);

    expect(send).toHaveBeenCalledWith('email.sendAccountCreated', {
      to: 'lan@tutor.dev',
      email: 'lan@tutor.dev',
      username: 'lan.nguyen',
      password: 'Secret-Pass-999',
      displayName: 'Lan',
    });
  });

  it('does not send to a placeholder @no-email.local address', async () => {
    const send = jest.fn();
    await sendAccountCreatedMail({ send } as unknown as AccountMailClient, {
      ...input,
      email: 'lan.nguyen@no-email.local',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the mail RPC fails, and logs only the error name', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('boom Secret-Pass-999'), { name: 'TimeoutError' }),
      );
    await expect(
      sendAccountCreatedMail({ send } as unknown as AccountMailClient, input),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0][0]);
    expect(logged).toContain('TimeoutError');
    expect(logged).toContain(input.userId);
    expect(logged).not.toContain('Secret-Pass-999');
  });
});
