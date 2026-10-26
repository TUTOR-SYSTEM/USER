import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '@packages/decorators';
import { JwtAuthGuard } from 'src/packages/guards/jwt-auth.guard';
import { clearSessionCache } from 'src/packages/helpers/session-check.helper';
import { ServiceUnavailableException } from '@nestjs/common';

type Row = { id: string; isActive: boolean }[];

/** Minimal PrismaService: `user.findUnique()` resolves to the first of `rows` (or null). */
function makeDb(rows: Row | Error) {
  const findUnique = jest.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows[0] ?? null),
  );
  return { db: { user: { findUnique } }, findUnique };
}

function makeContext(headers: Record<string, string | undefined>, isPublic = false) {
  const request: Record<string, unknown> = { headers };
  const handler = () => undefined;
  class Controller {}
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => Controller,
    __isPublic: isPublic,
  } as unknown as ExecutionContext & { __isPublic: boolean };
  return { ctx, request };
}

describe('JwtAuthGuard', () => {
  const SECRET = 'test-access-secret';
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const SID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => clearSessionCache());

  const jwt = new JwtService({});
  const signToken = (payload: Record<string, unknown>, secret = SECRET) =>
    jwt.sign(payload, { secret });

  const validPayload = {
    sub: USER_ID,
    email: 'student@example.com',
    typ: 'access',
    role: 'STUDENT',
    sid: SID,
  };

  function build(opts: {
    env?: Record<string, string | undefined>;
    isPublic?: boolean;
    db?: Row | Error;
    session?: boolean | Error;
  }) {
    const env = opts.env ?? { JWT_ACCESS_SECRET: SECRET };
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    const reflector = {
      getAllAndOverride: jest.fn((key: string) =>
        key === IS_PUBLIC_KEY ? !!opts.isPublic : undefined,
      ),
    } as unknown as Reflector;
    const database = makeDb(opts.db ?? [{ id: USER_ID, isActive: true }]);
    const session = opts.session ?? true;
    const rmq = {
      send: jest.fn(() =>
        session instanceof Error ? Promise.reject(session) : Promise.resolve(session),
      ),
    };
    const guard = new JwtAuthGuard(jwt, config, reflector, database.db as never, rmq as never);
    return { guard, reflector, database, config, rmq };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  describe('public routes', () => {
    it('allows a @Public() route without any token and skips the DB lookup', async () => {
      const { guard, database } = build({ isPublic: true });
      const { ctx } = makeContext({});
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(database.findUnique).not.toHaveBeenCalled();
    });

    it('reads the public flag from both handler and class metadata', async () => {
      const { guard, reflector } = build({ isPublic: true });
      const { ctx } = makeContext({});
      await guard.canActivate(ctx);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [
        expect.any(Function),
        expect.any(Function),
      ]);
    });
  });

  describe('token extraction', () => {
    it.each<[string, Record<string, string | undefined>]>([
      ['missing authorization header', {}],
      ['undefined authorization', { authorization: undefined }],
      ['empty string', { authorization: '' }],
      ['basic scheme', { authorization: 'Basic abc' }],
      ['lowercase bearer scheme', { authorization: 'bearer abc' }],
      ['bearer without token', { authorization: 'Bearer' }],
      ['bearer with trailing space only', { authorization: 'Bearer ' }],
    ])('rejects %s with Unauthorized', async (_label, headers) => {
      const { guard, database } = build({});
      const { ctx } = makeContext(headers);
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(database.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when neither JWT_ACCESS_SECRET nor JWT_SECRET is configured', async () => {
      const { guard } = build({ env: {} });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('falls back to JWT_SECRET when JWT_ACCESS_SECRET is absent', async () => {
      const { guard } = build({ env: { JWT_SECRET: SECRET } });
      const { ctx, request } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request.user).toEqual({
        id: USER_ID,
        email: 'student@example.com',
        typ: 'access',
        role: 'STUDENT',
        sid: SID,
      });
    });

    it('prefers JWT_ACCESS_SECRET over JWT_SECRET', async () => {
      const { guard } = build({ env: { JWT_ACCESS_SECRET: SECRET, JWT_SECRET: 'other' } });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('signature and payload validation', () => {
    it('rejects a token signed with a different secret', async () => {
      const { guard, database } = build({});
      const { ctx } = makeContext(bearer(signToken(validPayload, 'wrong-secret')));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(database.findUnique).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      const { guard } = build({});
      const expired = jwt.sign(
        { ...validPayload, exp: Math.floor(Date.now() / 1000) - 60 },
        { secret: SECRET },
      );
      const { ctx } = makeContext(bearer(expired));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a malformed token string', async () => {
      const { guard } = build({});
      const { ctx } = makeContext(bearer('not.a.jwt'));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token whose typ is not "access" (e.g. refresh token)', async () => {
      const { guard, database } = build({});
      const { ctx } = makeContext(bearer(signToken({ ...validPayload, typ: 'refresh' })));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(database.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a token without sub', async () => {
      const { guard } = build({});
      const { sub: _sub, ...noSub } = validPayload;
      const { ctx } = makeContext(bearer(signToken(noSub)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token whose sub is not a string', async () => {
      const { guard } = build({});
      const { ctx } = makeContext(bearer(signToken({ ...validPayload, sub: 123 })));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token without email', async () => {
      const { guard } = build({});
      const { email: _email, ...noEmail } = validPayload;
      const { ctx } = makeContext(bearer(signToken(noEmail)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token whose email is not a string', async () => {
      const { guard } = build({});
      const { ctx } = makeContext(bearer(signToken({ ...validPayload, email: ['a@b.c'] })));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token without a role claim', async () => {
      const { guard } = build({});
      const { role: _role, ...noRole } = validPayload;
      const { ctx } = makeContext(bearer(signToken(noRole)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token whose role claim is not a string', async () => {
      const { guard } = build({});
      const { ctx } = makeContext(bearer(signToken({ ...validPayload, role: 1 })));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('downgrades an unknown string role to STUDENT', async () => {
      const { guard } = build({});
      const { ctx, request } = makeContext(
        bearer(signToken({ ...validPayload, role: 'SUPERUSER' })),
      );
      await guard.canActivate(ctx);
      expect((request.user as { role: string }).role).toBe('STUDENT');
    });

    it.each(['STUDENT', 'ADMIN', 'TUTOR', 'PARENT'])('keeps the known role %s', async (role) => {
      const { guard } = build({});
      const { ctx, request } = makeContext(bearer(signToken({ ...validPayload, role })));
      await guard.canActivate(ctx);
      expect((request.user as { role: string }).role).toBe(role);
    });
  });

  describe('user existence and status', () => {
    it('attaches request.user and allows an active user', async () => {
      const { guard, database } = build({ db: [{ id: USER_ID, isActive: true }] });
      const { ctx, request } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(request.user).toEqual({
        id: USER_ID,
        email: 'student@example.com',
        typ: 'access',
        role: 'STUDENT',
        sid: SID,
      });
      expect(database.findUnique).toHaveBeenCalledTimes(1);
      expect(database.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID },
        select: { id: true, isActive: true },
      });
    });

    it('rejects when the user row no longer exists', async () => {
      const { guard } = build({ db: [] });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when the user is deactivated', async () => {
      const { guard } = build({ db: [{ id: USER_ID, isActive: false }] });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    });

    it('still allows when isActive is null (only an explicit false blocks)', async () => {
      const { guard } = build({ db: [{ id: USER_ID, isActive: null as unknown as boolean }] });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('propagates a database failure instead of silently allowing', async () => {
      const { guard } = build({ db: new Error('connection refused') });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toThrow('connection refused');
    });
  });
  it('rejects a verified token whose payload is a bare string (not an object)', async () => {
    const { guard } = build({});
    const { ctx } = makeContext(
      bearer(jwt.sign('bare-string-payload' as never, { secret: SECRET })),
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  describe('session check (per-device logout)', () => {
    it('rejects a token whose session no longer exists in Redis', async () => {
      const { guard, database, rmq } = build({ session: false });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(rmq.send).toHaveBeenCalledWith(
        'redis.exists',
        { key: `session:${USER_ID}:${SID}` },
        expect.any(Number),
        expect.any(Number),
      );
      expect(database.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a legacy token that carries no sid', async () => {
      const { guard, rmq } = build({});
      const { sid: _unused, ...legacy } = validPayload;
      void _unused;
      const { ctx } = makeContext(bearer(signToken(legacy)));
      await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
      expect(rmq.send).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the session store is unreachable', async () => {
      const { guard } = build({ session: new Error('redis timeout') });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('fails open only when SESSION_CHECK_FAIL_OPEN=true is set', async () => {
      const { guard } = build({
        env: { JWT_ACCESS_SECRET: SECRET, SESSION_CHECK_FAIL_OPEN: 'true' },
        session: new Error('redis timeout'),
      });
      const { ctx } = makeContext(bearer(signToken(validPayload)));
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('exposes the sid on request.user', async () => {
      const { guard } = build({});
      const { ctx, request } = makeContext(bearer(signToken(validPayload)));
      await guard.canActivate(ctx);
      expect(request.user).toMatchObject({ id: USER_ID, sid: SID });
    });
  });
});
