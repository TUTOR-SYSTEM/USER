import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { ErrorInterceptor } from 'src/packages/interceptor/error.interceptor';

describe('ErrorInterceptor', () => {
  const interceptor = new ErrorInterceptor();
  const ctx = {} as ExecutionContext;

  const run = (error: unknown) => {
    const next: CallHandler = { handle: () => throwError(() => error) };
    return lastValueFrom(interceptor.intercept(ctx, next)).catch((e: unknown) => e);
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes the value through on success', async () => {
    const next: CallHandler = { handle: () => of({ ok: 1 }) };
    await expect(lastValueFrom(interceptor.intercept(ctx, next))).resolves.toEqual({ ok: 1 });
  });

  it('rethrows HttpException untouched', async () => {
    const http = new BadRequestException('client mistake');
    await expect(run(http)).resolves.toBe(http);
  });

  it('wraps an unknown Error as InternalServerError with its message and stack', async () => {
    const err = new Error('something broke');
    const out = (await run(err)) as InternalServerErrorException;
    expect(out).toBeInstanceOf(InternalServerErrorException);
    expect(out.message).toBe('something broke');
    expect(out.stack).toBe(err.stack);
  });

  it('logs the original error before wrapping it', async () => {
    const spy = jest.spyOn(Logger.prototype, 'error');
    await run(new Error('logged'));
    expect(spy).toHaveBeenCalledWith('logged', expect.any(String));
  });

  it('maps a non-Error throwable to a generic message', async () => {
    const out = (await run('string thrown')) as InternalServerErrorException;
    expect(out.message).toBe('Internal server error');
  });

  it.each([
    ['23503', 'Referenced record not found (foreign key violation)'],
    ['23505', 'Record already exists (duplicate value)'],
    ['23502', 'Required field is missing (not-null violation)'],
    ['P2003', 'Referenced record not found (foreign key violation)'],
    ['P2002', 'Record already exists (duplicate value)'],
    ['P2011', 'Required field is missing (not-null violation)'],
    ['23514', 'Value violates check constraint'],
  ])('maps postgres code %s to a friendly message', async (code, friendly) => {
    const err = Object.assign(new Error('raw sql text'), { code });
    const out = (await run(err)) as InternalServerErrorException;
    expect(out.message).toBe(friendly);
  });

  it('reads the postgres code from error.cause when it is not on the error itself', async () => {
    const err = Object.assign(new Error('wrapped'), { cause: { code: '23505' } });
    const out = (await run(err)) as InternalServerErrorException;
    expect(out.message).toBe('Record already exists (duplicate value)');
  });

  it('hides drizzle "Failed query:" text behind a generic database error', async () => {
    const out = (await run(
      new Error('Failed query: select * from users'),
    )) as InternalServerErrorException;
    expect(out.message).toBe('Database error');
  });

  it('hides prisma "Invalid `prisma.x()` invocation" text behind a generic database error', async () => {
    const out = (await run(
      new Error('\nInvalid `prisma.user.findMany()` invocation:\n\nsomething'),
    )) as InternalServerErrorException;
    expect(out.message).toBe('Database error');
  });

  it('falls back to the raw message for an unmapped postgres code', async () => {
    const err = Object.assign(new Error('some other error'), { code: '99999' });
    const out = (await run(err)) as InternalServerErrorException;
    expect(out.message).toBe('some other error');
  });
});
