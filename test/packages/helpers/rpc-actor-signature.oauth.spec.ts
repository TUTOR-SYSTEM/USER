import {
  RPC_ACTOR_MAX_AGE_MS,
  computeOAuthProfileSignature,
  verifyOAuthProfileSignature,
} from 'src/packages/helpers/rpc-actor-signature.helper';

const SECRET = 'secret';
const NOW = 1_700_000_000_000;
const sign = (providerId = 'g-1', email = 'a@b.test', ts = NOW) => ({
  providerId,
  email,
  oauthProfileSigTs: ts,
  oauthProfileSig: computeOAuthProfileSignature(
    { provider: 'google', providerId, email },
    ts,
    SECRET,
  ),
});

describe('OAuth profile signature', () => {
  it('accepts a fresh matching signature', () => {
    expect(verifyOAuthProfileSignature('google', sign(), SECRET, NOW)).toBe(true);
  });

  it('is bound to the provider, the provider id and the email', () => {
    expect(verifyOAuthProfileSignature('facebook', sign(), SECRET, NOW)).toBe(false);
    expect(
      verifyOAuthProfileSignature('google', { ...sign(), providerId: 'g-2' }, SECRET, NOW),
    ).toBe(false);
    expect(
      verifyOAuthProfileSignature('google', { ...sign(), email: 'x@b.test' }, SECRET, NOW),
    ).toBe(false);
  });

  it('refuses a stale signature, a wrong secret, a missing secret and missing fields', () => {
    const old = sign('g-1', 'a@b.test', NOW - RPC_ACTOR_MAX_AGE_MS - 1);
    expect(verifyOAuthProfileSignature('google', old, SECRET, NOW)).toBe(false);
    expect(verifyOAuthProfileSignature('google', sign(), 'other', NOW)).toBe(false);
    expect(verifyOAuthProfileSignature('google', sign(), undefined, NOW)).toBe(false);
    expect(
      verifyOAuthProfileSignature('google', { providerId: 'g-1', email: 'a@b.test' }, SECRET, NOW),
    ).toBe(false);
  });
});
