import { Logger } from '@nestjs/common';
import {
  sendAccountExistsMail,
  type AccountMailClient,
} from '../../../src/packages/helpers/account-mail.helper';

const input = { email: 'lan@tutor.dev', displayName: 'Lan' };

describe('sendAccountExistsMail', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends email.sendAccountExists to the registered address', async () => {
    const send = jest.fn().mockResolvedValue({ id: 'm1' });
    await sendAccountExistsMail({ send } as unknown as AccountMailClient, input);
    expect(send).toHaveBeenCalledWith('email.sendAccountExists', {
      to: 'lan@tutor.dev',
      email: 'lan@tutor.dev',
      displayName: 'Lan',
    });
  });

  it('skips placeholder addresses', async () => {
    const send = jest.fn();
    await sendAccountExistsMail({ send } as unknown as AccountMailClient, {
      ...input,
      email: 'x@no-email.local',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the mail RPC fails and logs only the error name', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('down'), { name: 'TimeoutError' }));
    await expect(
      sendAccountExistsMail({ send } as unknown as AccountMailClient, input),
    ).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0][0])).toContain('TimeoutError');
    expect(String(warn.mock.calls[0][0])).not.toContain('lan@tutor.dev');
  });
});
