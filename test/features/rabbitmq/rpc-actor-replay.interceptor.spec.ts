import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { RpcActorReplayInterceptor } from 'src/features/rabbitmq/rpc-actor-replay.interceptor';
import { RPC_ACTOR_MAX_AGE_MS } from '@packages/helpers';

function rpcContext(data: unknown, type: 'rpc' | 'http' = 'rpc') {
  return {
    getType: () => type,
    switchToRpc: () => ({ getData: () => data }),
  } as never;
}

const next = { handle: () => of('handled') } as never;

describe('RpcActorReplayInterceptor', () => {
  let rmq: { send: jest.Mock };
  let interceptor: RpcActorReplayInterceptor;

  beforeEach(() => {
    rmq = { send: jest.fn() };
    interceptor = new RpcActorReplayInterceptor(rmq as never);
  });

  it('lets the first delivery of a signed envelope through and counts it for the window', async () => {
    rmq.send.mockResolvedValueOnce({ count: 1 });

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ actorSig: 'sig-1' }), next)),
    ).resolves.toBe('handled');
    expect(rmq.send).toHaveBeenCalledWith(
      'redis.incr',
      { key: 'rpc-actor-replay:sig-1', windowSeconds: Math.ceil(RPC_ACTOR_MAX_AGE_MS / 1000) },
      expect.any(Number),
      0,
    );
  });

  it('refuses a second delivery of the same signature with 403', async () => {
    rmq.send.mockResolvedValueOnce({ count: 2 });

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ actorSig: 'sig-1' }), next)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes unsigned RPCs and HTTP requests through without touching Redis', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ userId: 'x' }), next)),
    ).resolves.toBe('handled');
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ actorSig: 'sig' }, 'http'), next)),
    ).resolves.toBe('handled');
    expect(rmq.send).not.toHaveBeenCalled();
  });

  it('fails closed when the replay counter cannot be reached', async () => {
    rmq.send.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ actorSig: 'sig-2' }), next)),
    ).rejects.toThrow('redis down');
  });
});
