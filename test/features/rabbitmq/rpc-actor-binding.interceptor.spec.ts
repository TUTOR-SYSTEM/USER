import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { RpcActorBindingInterceptor } from 'src/features/rabbitmq/rpc-actor-binding.interceptor';
import {
  computeRpcActorSignature,
  computeRpcBindSignature,
  hashRpcPayload,
} from '@packages/helpers/rpc-actor-signature.helper';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const next = { handle: () => of('handled') } as never;

function rpcContext(data: unknown, pattern: string, type: 'rpc' | 'http' = 'rpc') {
  return {
    getType: () => type,
    switchToRpc: () => ({ getData: () => data, getContext: () => ({ getPattern: () => pattern }) }),
  } as never;
}

/** Signs a payload the way the gateway does (actor signature + bind). */
function sign(payload: Record<string, unknown>, pattern: string) {
  const sigTs = Date.now();
  const actorSig = computeRpcActorSignature(
    { actorId: 'admin-1', actorRole: 'ADMIN', actorSid: '', actorSigTs: sigTs },
    SECRET,
  );
  const signed: Record<string, unknown> = {
    ...payload,
    actorId: 'admin-1',
    actorRole: 'ADMIN',
    actorSid: '',
    actorSigTs: sigTs,
    actorSig,
  };
  signed.actorBind = computeRpcBindSignature(
    { pattern, payloadHash: hashRpcPayload(signed), actorSig, actorSigTs: sigTs },
    SECRET,
  );
  return signed;
}

describe('RpcActorBindingInterceptor', () => {
  const interceptor = new RpcActorBindingInterceptor();
  const original = process.env.RPC_ACTOR_SECRET;

  beforeEach(() => {
    process.env.RPC_ACTOR_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.RPC_ACTOR_SECRET = original;
  });

  const run = async (data: unknown, pattern: string) =>
    lastValueFrom(interceptor.intercept(rpcContext(data, pattern), next) as ReturnType<typeof of>);

  it('lets an envelope through when pattern and payload match what was signed', async () => {
    await expect(
      run(sign({ id: 'u-1' }, 'admin.deleteStudent'), 'admin.deleteStudent'),
    ).resolves.toBe('handled');
  });

  it('is not disturbed by key order or undefined fields', async () => {
    const signed = sign({ b: 1, a: { y: 2, x: 1 }, skip: undefined }, 'p.x');
    const reordered = { a: { x: 1, y: 2 }, ...signed, b: 1 };
    await expect(run(reordered, 'p.x')).resolves.toBe('handled');
  });

  it('refuses the same actor with a swapped payload', async () => {
    const signed = sign({ id: 'victim-1' }, 'admin.deleteStudent');
    await expect(run({ ...signed, id: 'victim-2' }, 'admin.deleteStudent')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses the same envelope on another pattern', async () => {
    const signed = sign({ id: 'u-1' }, 'admin.getStudent');
    await expect(run(signed, 'admin.deleteStudent')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a signed actor that carries no bind', async () => {
    const { actorBind: _drop, ...noBind } = sign({ id: 'u-1' }, 'p.x');
    await expect(run(noBind, 'p.x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses everything when the secret is not configured', async () => {
    const signed = sign({ id: 'u-1' }, 'p.x');
    delete process.env.RPC_ACTOR_SECRET;
    await expect(run(signed, 'p.x')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes unsigned RPCs and HTTP requests through', async () => {
    await expect(run({ id: 'u-1' }, 'p.x')).resolves.toBe('handled');
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ actorSig: 'x' }, 'p.x', 'http'), next)),
    ).resolves.toBe('handled');
  });
});
