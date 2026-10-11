import { ArgumentsHost, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { HttpExceptionFilter } from 'src/packages/filters/http-exception.filter';
import { ERROR_MESSAGES } from 'src/data/constants';

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();
  const originalEnv = process.env.NODE_ENV;

  const run = (exception: unknown, opts: { url?: string; language?: 'vi' | 'en' } = {}) => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const request = { url: opts.url ?? '/students', language: opts.language };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    filter.catch(exception as HttpException, host);
    return { status, json, body: json.mock.calls[0]?.[0] as Record<string, unknown> };
  };

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('responds with the exception status and the standard envelope', () => {
    const { status, body } = run(new BadRequestException('Bad input'));
    expect(status).toHaveBeenCalledWith(400);
    expect(body).toMatchObject({
      success: false,
      statusCode: 400,
      message: 'Bad input',
      path: '/students',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('translates a known error code into the requested language', () => {
    const { body } = run(new BadRequestException(ERROR_MESSAGES.STUDENT_NOT_FOUND), {
      language: 'en',
    });
    expect(body.message).toBe('Student not found');
  });

  it('defaults to Vietnamese when no language is resolved', () => {
    const { body } = run(new BadRequestException(ERROR_MESSAGES.STUDENT_NOT_FOUND));
    expect(body.message).toBe('Không tìm thấy học sinh');
  });

  it('localizes a composed "CODE: suffix" message and keeps the suffix', () => {
    const { body } = run(new BadRequestException(`${ERROR_MESSAGES.STUDENT_CODE_EXISTS}: STU001`), {
      language: 'en',
    });
    expect(body.message).toBe('Student code already exists: STU001');
  });

  it('joins array messages (validation) and translates each item', () => {
    const exception = new BadRequestException({
      message: [ERROR_MESSAGES.STUDENT_NOT_FOUND, 'Plain validation text'],
    });
    const { body } = run(exception, { language: 'en' });
    expect(body.message).toBe('Student not found, Plain validation text');
  });

  it('passes a string response body straight through as the message', () => {
    const { body } = run(new HttpException('raw text', HttpStatus.CONFLICT));
    expect(body).toMatchObject({ statusCode: 409, message: 'raw text' });
  });

  it('falls back to the generic message when an object response has no message field', () => {
    // Current behaviour: the 403 status is kept, but the text is the generic fallback, not exception.message.
    const { status, body } = run(new HttpException({ other: 1 }, HttpStatus.FORBIDDEN));
    expect(status).toHaveBeenCalledWith(403);
    expect(body.message).toBe('Internal server error');
  });

  it('keeps per-field Zod errors and translates their messages', () => {
    const exception = new HttpException(
      {
        message: ERROR_MESSAGES.VALIDATION_FAILED,
        errors: [{ field: 'name', message: ERROR_MESSAGES.STUDENT_NOT_FOUND, code: 'custom' }],
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    const { body } = run(exception, { language: 'en' });
    expect(body.errors).toEqual([{ field: 'name', message: 'Student not found', code: 'custom' }]);
  });

  it('leaves error items without a string message untouched', () => {
    const exception = new HttpException(
      { message: 'x', errors: [{ field: 'a' }, 'raw'] },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    const { body } = run(exception);
    expect(body.errors).toEqual([{ field: 'a' }, 'raw']);
  });

  it('includes the stack trace for 5xx outside production only', () => {
    process.env.NODE_ENV = 'development';
    const dev = run(new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(dev.body.trace).toEqual(expect.any(String));

    process.env.NODE_ENV = 'production';
    const prod = run(new HttpException('boom', HttpStatus.INTERNAL_SERVER_ERROR));
    expect(prod.body).not.toHaveProperty('trace');
  });

  it('never includes a trace for 4xx, even outside production', () => {
    process.env.NODE_ENV = 'development';
    const { body } = run(new BadRequestException('nope'));
    expect(body).not.toHaveProperty('trace');
  });
  it('falls back to the generic message when the thrown error has no text at all', () => {
    const { body } = run({ message: '' });
    expect(body).toMatchObject({ message: 'Internal server error' });
  });

  it('uses the thrown error message when the exception carries no response body', () => {
    const bare = { message: 'plain failure' };
    const { status, body } = run(bare);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body).toMatchObject({ message: 'plain failure' });
  });
});
