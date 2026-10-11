import { ConfigService } from '@nestjs/config';
import { JwtUserStrategy } from 'src/packages/strategy/jwt-user.strategy';

describe('JwtUserStrategy', () => {
  const build = (secret?: string) => {
    const config = { get: jest.fn(() => secret) } as unknown as ConfigService;
    return new JwtUserStrategy(config);
  };

  it('returns the verified payload unchanged from validate()', () => {
    const payload = { sub: 'u1', email: 'a@b.c', typ: 'access', role: 'STUDENT' };
    expect(build('s').validate(payload as never)).toBe(payload);
  });

  it('reads JWT_ACCESS_SECRET from config', () => {
    const config = { get: jest.fn(() => 'configured-secret') } as unknown as ConfigService;
    new JwtUserStrategy(config);
    expect(config.get).toHaveBeenCalledWith('JWT_ACCESS_SECRET');
  });

  const resolveSecret = (strategy: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      (
        strategy as {
          _secretOrKeyProvider: (
            r: unknown,
            t: string,
            d: (e: unknown, k: unknown) => void,
          ) => void;
        }
      )._secretOrKeyProvider({}, 'raw', (err, key) => (err ? reject(err) : resolve(key)));
    });

  it('KNOWN ISSUE: falls back to a hard-coded public secret when JWT_ACCESS_SECRET is unset', async () => {
    // Pinned to current behaviour. A token signed with this fallback would be accepted.
    await expect(resolveSecret(build(undefined))).resolves.toBe('dev-insecure-secret');
  });

  it('uses the configured secret as the verification key', async () => {
    await expect(resolveSecret(build('real-secret'))).resolves.toBe('real-secret');
  });
});
