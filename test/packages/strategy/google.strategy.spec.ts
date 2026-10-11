import { ConfigService } from '@nestjs/config';
import { GoogleStrategy } from 'src/packages/strategy/google.strategy';

describe('GoogleStrategy', () => {
  const build = (env: Record<string, string | undefined> = {}) =>
    new GoogleStrategy({ get: (key: string) => env[key] } as unknown as ConfigService);

  const profile = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'g-123',
      displayName: 'Ann Lee',
      emails: [{ value: 'ann@example.com' }],
      name: { givenName: 'Ann', familyName: 'Lee' },
      photos: [{ value: 'https://img.example/ann.png' }],
      ...overrides,
    }) as never;

  it('maps a complete Google profile to the internal shape', () => {
    expect(build().validate('at', 'rt', profile())).toEqual({
      googleId: 'g-123',
      email: 'ann@example.com',
      firstName: 'Ann',
      lastName: 'Lee',
      avatar: 'https://img.example/ann.png',
    });
  });

  it('rejects a profile without any email', () => {
    expect(() => build().validate('at', 'rt', profile({ emails: [] }))).toThrow(
      'Google account has no public email',
    );
    expect(() => build().validate('at', 'rt', profile({ emails: undefined }))).toThrow(
      'Google account has no public email',
    );
  });

  it('falls back to displayName, then "Google", for the first name', () => {
    const named = build().validate('at', 'rt', profile({ name: undefined, displayName: 'Shown' }));
    expect(named).toMatchObject({ firstName: 'Shown', lastName: 'User' });

    const bare = build().validate('at', 'rt', profile({ name: undefined, displayName: '' }));
    expect(bare).toMatchObject({ firstName: 'Google', lastName: 'User' });
  });

  it('leaves avatar undefined when no photo is present', () => {
    expect(build().validate('at', 'rt', profile({ photos: undefined })).avatar).toBeUndefined();
  });

  it('uses env values for client config when present', () => {
    const s = build({
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'sec',
      GOOGLE_CALLBACK_URL: 'https://cb',
    });
    expect(s).toBeInstanceOf(GoogleStrategy);
  });
});
