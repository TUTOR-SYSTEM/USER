import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { computeRpcActorSignature } from '@packages/helpers';
import { ERROR_MESSAGES } from 'src/data/constants';
import { RpcMustChangePasswordInterceptor } from 'src/features/rabbitmq/rpc-must-change-password.interceptor';

const RPC_SECRET = 'test-rpc-actor-secret-that-is-long-enough-0123456789';
const USER_ID = '6f1c2b4e-9d3a-4c7e-8b21-0a1b2c3d4e5f';
const SID = '2b8f1d2e-4c5a-4b7e-9a1d-0e2f3a4b5c6d';

function signed(actorId: string, actorRole: string) {
  const actorSigTs = Date.now();
  const actorSig = computeRpcActorSignature(
    { actorId, actorRole, actorSid: SID, actorSigTs },
    RPC_SECRET,
  );
  return { actorId, actorRole, actorSid: SID, actorSigTs, actorSig };
}

function rpcContext(pattern: string, data: unknown, type: 'rpc' | 'http' = 'rpc') {
  return {
    getType: () => type,
    switchToRpc: () => ({
      getData: () => data,
      getContext: () => ({ getPattern: () => pattern }),
    }),
  } as never;
}

const next = { handle: () => of('handled') } as never;

describe('RpcMustChangePasswordInterceptor', () => {
  const originalSecret = process.env.RPC_ACTOR_SECRET;
  let db: { user: { findUnique: jest.Mock } };
  let interceptor: RpcMustChangePasswordInterceptor;

  beforeEach(() => {
    process.env.RPC_ACTOR_SECRET = RPC_SECRET;
    db = { user: { findUnique: jest.fn().mockResolvedValue({ mustChangePassword: true }) } };
    interceptor = new RpcMustChangePasswordInterceptor(db as never);
  });

  afterAll(() => {
    process.env.RPC_ACTOR_SECRET = originalSecret;
  });

  it('refuses an acting RPC from a must-change-password account with 403', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext('student.findAll', signed(USER_ID, 'STUDENT')), next),
      ),
    ).rejects.toMatchObject({ message: ERROR_MESSAGES.MUST_CHANGE_PASSWORD });
    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext('student.findAll', signed(USER_ID, 'STUDENT')), next),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { mustChangePassword: true },
    });
  });

  it.each(['user.changePassword', 'auth.logout'])(
    'lets %s through so the user can leave the temporary password',
    async (pattern) => {
      await expect(
        lastValueFrom(interceptor.intercept(rpcContext(pattern, signed(USER_ID, 'STUDENT')), next)),
      ).resolves.toBe('handled');
      expect(db.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it('lets an account without the flag through', async () => {
    db.user.findUnique.mockResolvedValueOnce({ mustChangePassword: false });
    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext('student.findAll', signed(USER_ID, 'STUDENT')), next),
      ),
    ).resolves.toBe('handled');
  });

  it('does not check unsigned or unauthenticated RPCs (the handler refuses an empty actor)', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext('auth.login', { email: 'a@b.test' }), next)),
    ).resolves.toBe('handled');
    const forged = { ...signed(USER_ID, 'STUDENT'), actorRole: 'ADMIN' };
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext('student.findAll', forged), next)),
    ).resolves.toBe('handled');
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('passes HTTP contexts through untouched', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext('x', signed(USER_ID, 'STUDENT'), 'http'), next),
      ),
    ).resolves.toBe('handled');
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup itself fails', async () => {
    db.user.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(
      lastValueFrom(
        interceptor.intercept(rpcContext('student.findAll', signed(USER_ID, 'STUDENT')), next),
      ),
    ).rejects.toThrow('db down');
  });
});
