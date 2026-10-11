import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import { RpcExceptionFilter } from 'src/packages/filters/rpc-exception.filter';

const run = (exception: unknown) => {
  const filter = new RpcExceptionFilter();
  const result = filter.catch(exception, {} as never);
  return lastValueFrom(result).catch((payload: unknown) => payload as Record<string, unknown>);
};

describe('RpcExceptionFilter', () => {
  it('serializes an HttpException into a plain payload with status and message', async () => {
    await expect(run(new BadRequestException('bad input'))).resolves.toEqual({
      statusCode: 400,
      message: 'bad input',
      errors: undefined,
      serviceName: 'user-service',
    });
  });

  it('keeps Zod-style errors so the caller can rebuild the 422 body', async () => {
    const errors = [{ field: 'email', message: 'Invalid', code: 'invalid_string' }];
    const payload = await run(
      new HttpException({ message: 'Validation failed', errors }, HttpStatus.UNPROCESSABLE_ENTITY),
    );
    expect(payload).toMatchObject({ statusCode: 422, message: 'Validation failed', errors });
  });

  it('uses a string response as the message', async () => {
    await expect(run(new HttpException('plain', HttpStatus.CONFLICT))).resolves.toMatchObject({
      statusCode: 409,
      message: 'plain',
    });
  });

  it('falls back to the exception message when the response object has none', async () => {
    await expect(run(new HttpException({ x: 1 }, HttpStatus.FORBIDDEN))).resolves.toMatchObject({
      statusCode: 403,
      message: 'Http Exception',
    });
  });

  it('preserves the origin serviceName when relaying another service error', async () => {
    const relayed = new HttpException(
      { message: 'tutor failed', serviceName: 'tutor-service' },
      HttpStatus.BAD_GATEWAY,
    );
    await expect(run(relayed)).resolves.toMatchObject({
      statusCode: 502,
      serviceName: 'tutor-service',
    });
  });

  it('wraps a plain Error as 500 with its message', async () => {
    await expect(run(new Error('db exploded'))).resolves.toEqual({
      statusCode: 500,
      message: 'db exploded',
      serviceName: 'user-service',
    });
  });

  it('wraps a non-Error throwable as 500 with a generic message', async () => {
    await expect(run('weird')).resolves.toEqual({
      statusCode: 500,
      message: 'Internal server error',
      serviceName: 'user-service',
    });
  });
});
