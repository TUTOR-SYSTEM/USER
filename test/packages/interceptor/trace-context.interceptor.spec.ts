import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
  CORRELATION_ID_HEADER,
  getRequestContext,
  PARENT_TRACE_ID_HEADER,
} from '@packages/context/request-context';
import { TraceContextInterceptor } from 'src/packages/interceptor/trace-context.interceptor';

type RpcOpts = { pattern?: string | null; headers?: Record<string, unknown>; noMessage?: boolean };

function rpcContext(opts: RpcOpts = {}): ExecutionContext {
  const { pattern = 'some.pattern', headers = {}, noMessage = false } = opts;
  return {
    getType: () => 'rpc',
    getHandler: () => ({ name: 'handler' }),
    switchToRpc: () => ({
      getData: () => ({ a: 1 }),
      getContext: () => ({
        getPattern: pattern === null ? undefined : () => pattern,
        getMessage: noMessage ? undefined : () => ({ properties: { headers } }),
      }),
    }),
  } as unknown as ExecutionContext;
}

const capturing = (seen: unknown[]): CallHandler => ({
  handle: () => {
    seen.push(getRequestContext());
    return of('ok');
  },
});

describe('TraceContextInterceptor', () => {
  const interceptor = new TraceContextInterceptor();

  afterEach(() => jest.restoreAllMocks());

  it('passes HTTP contexts straight through', async () => {
    const handle = jest.fn(() => of('http-body'));
    const httpCtx = { getType: () => 'http' } as unknown as ExecutionContext;
    await expect(lastValueFrom(interceptor.intercept(httpCtx, { handle }))).resolves.toBe(
      'http-body',
    );
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('propagates correlation and parent trace ids into the request context', async () => {
    const seen: unknown[] = [];
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({
          headers: {
            [CORRELATION_ID_HEADER]: Buffer.from('corr-buf'),
            [PARENT_TRACE_ID_HEADER]: 'parent-1',
          },
        }),
        capturing(seen),
      ),
    );
    expect(seen[0]).toMatchObject({
      correlationId: 'corr-buf',
      parentTraceId: 'parent-1',
      serviceName: 'user-service',
    });
    expect((seen[0] as { traceId: string }).traceId).toEqual(expect.any(String));
  });

  it('mints a correlation id when headers are missing or non-string', async () => {
    const seen: unknown[] = [];
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({ headers: { [CORRELATION_ID_HEADER]: 42 } }),
        capturing(seen),
      ),
    );
    await lastValueFrom(interceptor.intercept(rpcContext({ noMessage: true }), capturing(seen)));
    for (const ctx of seen as { correlationId: unknown; parentTraceId?: string }[]) {
      expect(ctx.correlationId).toEqual(expect.any(String));
      expect(ctx.correlationId).not.toBe(42);
      expect(ctx.parentTraceId).toBeUndefined();
    }
  });

  it('works when the RPC context has no pattern getter', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext({ pattern: null }), capturing([]))),
    ).resolves.toBe('ok');
  });

  it('propagates handler errors unchanged', async () => {
    const err = new Error('bad input');
    const failing: CallHandler = { handle: () => throwError(() => err) };
    await expect(lastValueFrom(interceptor.intercept(rpcContext(), failing))).rejects.toBe(err);
  });
});
