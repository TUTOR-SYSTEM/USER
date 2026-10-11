import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { RequestLogEntry, setLogSink } from '@packages/context/log-sink';
import {
  CORRELATION_ID_HEADER,
  PARENT_TRACE_ID_HEADER,
  SERVICE_NAME_HEADER,
} from '@packages/context/request-context';
import {
  resolveServiceHost,
  TraceContextInterceptor,
} from 'src/packages/interceptor/trace-context.interceptor';

type RpcOpts = {
  pattern?: string | null;
  data?: unknown;
  headers?: Record<string, unknown>;
  noMessage?: boolean;
};

function rpcContext(opts: RpcOpts = {}): ExecutionContext {
  const { pattern = 'some.pattern', headers = {}, noMessage = false } = opts;
  // `data` is read with `in` so an explicit `data: undefined` is honoured rather than defaulted.
  const data = 'data' in opts ? opts.data : { a: 1 };
  return {
    getType: () => 'rpc',
    getHandler: () => ({ name: 'handler' }),
    switchToRpc: () => ({
      getData: () => data,
      getContext: () => ({
        getPattern: pattern === null ? undefined : () => pattern,
        getMessage: noMessage ? undefined : () => ({ properties: { headers } }),
      }),
    }),
  } as unknown as ExecutionContext;
}

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });
const handlerFailing = (err: unknown): CallHandler => ({ handle: () => throwError(() => err) });

describe('TraceContextInterceptor host', () => {
  const original = { host: process.env.SERVICE_HOST, port: process.env.PORT };

  afterEach(() => {
    jest.restoreAllMocks();
    if (original.host === undefined) delete process.env.SERVICE_HOST;
    else process.env.SERVICE_HOST = original.host;
    if (original.port === undefined) delete process.env.PORT;
    else process.env.PORT = original.port;
  });

  it('uses SERVICE_HOST when set', () => {
    process.env.SERVICE_HOST = 'svc:50051';
    expect(resolveServiceHost()).toBe('svc:50051');
  });

  it('falls back to SERVICE_NAME:PORT', () => {
    delete process.env.SERVICE_HOST;
    process.env.PORT = '4002';
    expect(resolveServiceHost()).toMatch(/^[a-z-]+-service:4002$/);
  });

  it('falls back to the default port when PORT is unset', () => {
    delete process.env.SERVICE_HOST;
    delete process.env.PORT;
    expect(resolveServiceHost()).toMatch(/^[a-z-]+-service:8888$/);
  });

  it('includes host in the emitted log entry', async () => {
    process.env.SERVICE_HOST = 'svc:50051';
    const spy = jest.fn<unknown, [RequestLogEntry]>();
    setLogSink(spy);
    await lastValueFrom(
      new TraceContextInterceptor().intercept(rpcContext(), handlerReturning('ok')),
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ host: 'svc:50051', type: 'RPC' }));
  });
});

describe('TraceContextInterceptor', () => {
  let sink: jest.Mock<unknown, [RequestLogEntry]>;

  beforeEach(() => {
    sink = jest.fn();
    setLogSink(sink);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setLogSink(() => undefined);
  });

  const interceptor = new TraceContextInterceptor();

  it('passes HTTP contexts straight through without logging or emitting', async () => {
    const handle = jest.fn(() => of('http-body'));
    const httpCtx = { getType: () => 'http' } as unknown as ExecutionContext;

    await expect(lastValueFrom(interceptor.intercept(httpCtx, { handle }))).resolves.toBe(
      'http-body',
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();
  });

  it('emits a successful RPC hop with request and response previews', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(
        rpcContext({
          pattern: 'user.getUserById',
          data: { id: 'u-1', password: 'secret' },
          headers: { [CORRELATION_ID_HEADER]: 'corr-1', [SERVICE_NAME_HEADER]: 'gateway' },
        }),
        handlerReturning({ ok: true, token: 't' }),
      ),
    );

    expect(result).toEqual({ ok: true, token: 't' });
    expect(sink).toHaveBeenCalledTimes(1);
    const entry = sink.mock.calls[0][0];
    expect(entry).toMatchObject({
      serviceName: 'user-service',
      type: 'RPC',
      path: 'user.getUserById',
      correlationId: 'corr-1',
      requestBody: JSON.stringify({ id: 'u-1', password: '[REDACTED]' }),
      responseBody: JSON.stringify({ ok: true, token: '[REDACTED]' }),
    });
    expect(entry.traceId).toEqual(expect.any(String));
  });

  it('reads Buffer-encoded headers and keeps the caller parent trace id', async () => {
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({
          headers: {
            [CORRELATION_ID_HEADER]: Buffer.from('corr-buf'),
            [PARENT_TRACE_ID_HEADER]: Buffer.from('parent-buf'),
            [SERVICE_NAME_HEADER]: Buffer.from('tutor-service'),
          },
        }),
        handlerReturning(undefined),
      ),
    );

    expect(sink.mock.calls[0][0]).toMatchObject({
      correlationId: 'corr-buf',
      parentTraceId: 'parent-buf',
    });
  });

  it('mints a fresh correlation id and leaves parentTraceId empty when headers are missing', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext({ headers: {} }), handlerReturning(undefined)),
    );

    const entry = sink.mock.calls[0][0];
    expect(entry.correlationId).toEqual(expect.any(String));
    expect(entry.correlationId.length).toBeGreaterThan(0);
    expect(entry.parentTraceId).toBeUndefined();
  });

  it('ignores non-string header values', async () => {
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({
          headers: { [CORRELATION_ID_HEADER]: 42, [PARENT_TRACE_ID_HEADER]: { x: 1 } },
        }),
        handlerReturning(undefined),
      ),
    );

    const entry = sink.mock.calls[0][0];
    expect(entry.correlationId).not.toBe(42);
    expect(entry.parentTraceId).toBeUndefined();
  });

  it('falls back to the handler name when the RPC context has no pattern getter', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext({ pattern: null }), handlerReturning(undefined)),
    );

    expect(sink.mock.calls[0][0].path).toBe('handler');
  });

  it('tolerates a missing RMQ message and logs the caller as unknown', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext({ noMessage: true }), handlerReturning(undefined)),
    );

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0].parentTraceId).toBeUndefined();
  });

  it('does not emit a request row for log.* plumbing patterns', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext({ pattern: 'log.request' }), handlerReturning('ok')),
    );

    expect(sink).not.toHaveBeenCalled();
  });

  it('does not emit a request row for log.* patterns that fail', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(
          rpcContext({ pattern: 'log.request' }),
          handlerFailing(new Error('x')),
        ),
      ),
    ).rejects.toThrow('x');

    expect(sink).not.toHaveBeenCalled();
  });

  it('omits the request body when the RPC payload is undefined', async () => {
    await lastValueFrom(
      interceptor.intercept(rpcContext({ data: undefined }), handlerReturning(undefined)),
    );

    expect(sink.mock.calls[0][0].requestBody).toBeUndefined();
    expect(sink.mock.calls[0][0].responseBody).toBeUndefined();
  });

  it('omits the request body when reading the payload throws', async () => {
    // First switchToRpc() call reads the context; the second (for the payload) blows up.
    let calls = 0;
    const ctx = {
      getType: () => 'rpc',
      getHandler: () => ({ name: 'handler' }),
      switchToRpc: () => {
        calls += 1;
        if (calls > 1) throw new Error('no payload');
        return { getContext: () => ({ getPattern: () => 'user.x', getMessage: () => ({}) }) };
      },
    } as unknown as ExecutionContext;

    await lastValueFrom(interceptor.intercept(ctx, handlerReturning('ok')));

    expect(sink.mock.calls[0][0].requestBody).toBeUndefined();
    expect(sink.mock.calls[0][0].responseBody).toBe('"ok"');
  });

  it('redacts sensitive keys nested inside arrays and objects', async () => {
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({
          data: {
            users: [{ refreshToken: 'r', name: 'a' }],
            oldPassword: 'o',
            confirmPassword: 'c',
          },
        }),
        handlerReturning(undefined),
      ),
    );

    const body = JSON.parse(sink.mock.calls[0][0].requestBody as string);
    expect(body).toEqual({
      users: [{ refreshToken: '[REDACTED]', name: 'a' }],
      oldPassword: '[REDACTED]',
      confirmPassword: '[REDACTED]',
    });
  });

  it('keeps null and primitive values intact while redacting', async () => {
    await lastValueFrom(
      interceptor.intercept(
        rpcContext({ data: { nothing: null, n: 3, flag: true } }),
        handlerReturning(undefined),
      ),
    );

    expect(JSON.parse(sink.mock.calls[0][0].requestBody as string)).toEqual({
      nothing: null,
      n: 3,
      flag: true,
    });
  });

  it('truncates oversized request and response previews at 1000 characters', async () => {
    const big = 'x'.repeat(2000);
    await lastValueFrom(
      interceptor.intercept(rpcContext({ data: { big } }), handlerReturning({ big })),
    );

    const entry = sink.mock.calls[0][0];
    expect(entry.requestBody).toHaveLength(1000 + '…(truncated)'.length);
    expect(entry.requestBody).toMatch(/…\(truncated\)$/);
    expect(entry.responseBody).toMatch(/…\(truncated\)$/);
  });

  it('returns no response preview when the handler resolves with undefined', async () => {
    await lastValueFrom(interceptor.intercept(rpcContext(), handlerReturning(undefined)));
    expect(sink.mock.calls[0][0].responseBody).toBeUndefined();
  });

  it('returns no response preview when the response cannot be serialized', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await lastValueFrom(interceptor.intercept(rpcContext(), handlerReturning(circular)));
    expect(sink.mock.calls[0][0].responseBody).toBeUndefined();
  });

  it('propagates handler errors and emits an error row with the error preview', async () => {
    const err = Object.assign(new Error('bad input'), {
      getStatus: () => 400,
      getResponse: () => ({ message: 'bad input', password: 'p' }),
    });

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(err))),
    ).rejects.toBe(err);

    const entry = sink.mock.calls[0][0];
    expect(entry.errorMessage).toBe('bad input');
    expect(JSON.parse(entry.responseBody as string)).toEqual({
      statusCode: 400,
      message: 'bad input',
      password: '[REDACTED]',
    });
  });

  it('wraps a string getResponse() as the error message', async () => {
    const err = Object.assign(new Error('nope'), {
      getStatus: () => 404,
      getResponse: () => 'Not here',
    });

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(err))),
    ).rejects.toBe(err);

    expect(JSON.parse(sink.mock.calls[0][0].responseBody as string)).toEqual({
      statusCode: 404,
      message: 'Not here',
    });
  });

  it('uses the status-less shape when getResponse exists but getStatus does not', async () => {
    const err = { getResponse: () => ({ message: 'x' }), message: 'x' };

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(err))),
    ).rejects.toBe(err);

    expect(JSON.parse(sink.mock.calls[0][0].responseBody as string)).toEqual({ message: 'x' });
  });

  it('serializes a plain Error as name + message when it has no getResponse', async () => {
    const err = new TypeError('kaboom');

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(err))),
    ).rejects.toBe(err);

    expect(JSON.parse(sink.mock.calls[0][0].responseBody as string)).toEqual({
      name: 'TypeError',
      message: 'kaboom',
    });
  });

  it('serializes a non-Error thrown value as-is', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing({ code: 'E_X' }))),
    ).rejects.toEqual({ code: 'E_X' });

    expect(JSON.parse(sink.mock.calls[0][0].responseBody as string)).toEqual({ code: 'E_X' });
    expect(sink.mock.calls[0][0].errorMessage).toBe('[object Object]');
  });

  it('returns no error preview when the thrown value cannot be serialized', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(circular))),
    ).rejects.toBe(circular);

    expect(sink.mock.calls[0][0].responseBody).toBeUndefined();
  });

  it('truncates oversized error previews', async () => {
    const err = Object.assign(new Error('big'), {
      getResponse: () => ({ detail: 'y'.repeat(2000) }),
    });

    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(err))),
    ).rejects.toBe(err);

    expect(sink.mock.calls[0][0].responseBody).toMatch(/…\(truncated\)$/);
  });

  it('reports a missing errorMessage as the stringified value for falsy errors', async () => {
    await expect(
      lastValueFrom(interceptor.intercept(rpcContext(), handlerFailing(null))),
    ).rejects.toBeNull();

    expect(sink.mock.calls[0][0].errorMessage).toBe('null');
  });
});
