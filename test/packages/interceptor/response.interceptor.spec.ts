import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from 'src/packages/interceptor/response.interceptor';

describe('ResponseInterceptor', () => {
  const makeCtx = (opts: {
    method?: string;
    url?: string;
    language?: 'vi' | 'en';
    status?: number;
  }) => {
    const request = {
      method: opts.method ?? 'GET',
      url: opts.url ?? '/x',
      language: opts.language,
    };
    const response = { statusCode: opts.status ?? 200 };
    return {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
    } as unknown as ExecutionContext;
  };

  const run = (
    ctx: ExecutionContext,
    data: unknown,
    metadata?: { message?: string } | undefined,
  ) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(metadata as never);
    const interceptor = new ResponseInterceptor(reflector);
    const next: CallHandler = { handle: () => of(data) };
    return lastValueFrom(interceptor.intercept(ctx, next));
  };

  afterEach(() => jest.restoreAllMocks());

  it('wraps the handler result in the standard envelope', async () => {
    const out = await run(makeCtx({ method: 'POST', url: '/students', status: 201 }), { id: 1 });
    expect(out).toMatchObject({
      statusCode: 201,
      message: 'Thành công',
      data: { id: 1 },
      method: 'POST',
      path: '/students',
    });
    expect(out.timestamp).toBeInstanceOf(Date);
  });

  it('uses the @ApiResponse message when present', async () => {
    const out = await run(makeCtx({}), null, { message: 'Created successfully' });
    expect(out.message).toBe('Created successfully');
    expect(out.data).toBeNull();
  });

  it('translates a success message code into the request language', async () => {
    const vi = await run(makeCtx({ language: 'vi' }), null, { message: 'SUCCESS' });
    const en = await run(makeCtx({ language: 'en' }), null, { message: 'SUCCESS' });
    expect(en.message).toBe('Success');
    expect(vi.message).not.toBe(en.message);
  });

  it('defaults statusCode to 200 when the response has no status yet', async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/' }),
        getResponse: () => ({ statusCode: undefined }),
      }),
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
    } as unknown as ExecutionContext;
    const out = await run(ctx, 'ok');
    expect(out.statusCode).toBe(200);
  });
});
