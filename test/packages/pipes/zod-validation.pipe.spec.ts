import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from 'src/packages/pipes/zod-validation.pipe';
import { ERROR_MESSAGES } from 'src/data/constants';

describe('ZodValidationPipe', () => {
  const schema = z.object({
    name: z.string().min(2, 'name too short'),
    age: z.coerce.number().int().min(0),
    nested: z.object({ code: z.string().length(3, 'code length') }).optional(),
  });
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed (coerced / stripped) value on success', () => {
    expect(pipe.transform({ name: 'Ann', age: '21', extra: 'drop me' })).toEqual({
      name: 'Ann',
      age: 21,
    });
  });

  it('parses a JSON string body before validating it', () => {
    expect(pipe.transform('{"name":"Bob","age":5}')).toEqual({ name: 'Bob', age: 5 });
  });

  it('leaves a non-JSON string as-is, so validation fails on the raw string', () => {
    expect(() => pipe.transform('not json')).toThrow(UnprocessableEntityException);
  });

  it('leaves a JSON string that parses to a primitive unchanged for the schema', () => {
    expect(() => pipe.transform('"just a string"')).toThrow(UnprocessableEntityException);
  });

  it('throws 422 with the standard message and field errors', () => {
    try {
      pipe.transform({ name: 'A', age: -1 });
      throw new Error('expected to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const body = (error as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect(body).toMatchObject({
        statusCode: 422,
        message: ERROR_MESSAGES.VALIDATION_FAILED,
        errors: [
          { field: 'name', message: 'name too short', code: 'too_small' },
          { field: 'age', message: expect.any(String), code: 'too_small' },
        ],
      });
    }
  });

  it('keeps only the first issue per field', () => {
    const multi = new ZodValidationPipe(z.object({ name: z.string().min(5).max(1) }));
    try {
      multi.transform({ name: 'abc' });
      throw new Error('expected to throw');
    } catch (error) {
      const { errors } = (error as UnprocessableEntityException).getResponse() as {
        errors: unknown[];
      };
      expect(errors).toHaveLength(1);
    }
  });

  it('joins nested paths with dots', () => {
    try {
      pipe.transform({ name: 'Ann', age: 1, nested: { code: 'ab' } });
      throw new Error('expected to throw');
    } catch (error) {
      const { errors } = (error as UnprocessableEntityException).getResponse() as {
        errors: { field: string; message: string }[];
      };
      expect(errors).toEqual([
        { field: 'nested.code', message: 'code length', code: expect.any(String) },
      ]);
    }
  });

  it('reports an empty field name for a root-level issue', () => {
    const root = new ZodValidationPipe(z.string().min(3));
    try {
      root.transform('a');
      throw new Error('expected to throw');
    } catch (error) {
      const { errors } = (error as UnprocessableEntityException).getResponse() as {
        errors: { field: string }[];
      };
      expect(errors[0].field).toBe('');
    }
  });
});
