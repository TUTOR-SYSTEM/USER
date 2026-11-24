import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { compareData, hashData } from 'src/packages/helpers/hashingData.helper';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return { ...actual, hash: jest.fn(actual.hash), compare: jest.fn(actual.compare) };
});

const hashMock = bcrypt.hash as unknown as jest.Mock;
const compareMock = bcrypt.compare as unknown as jest.Mock;

describe('hashData / compareData', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('hashes with bcrypt and the expected salt rounds', async () => {
    const hash = await hashData('secret');
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hashMock).toHaveBeenCalledWith('secret', 12);
  });

  it('verifies a hash that matches and rejects one that does not', async () => {
    const hash = await hashData('secret');
    await expect(compareData('secret', hash)).resolves.toBe(true);
    await expect(compareData('wrong', hash)).resolves.toBe(false);
  });

  it('wraps a hashing failure in BadRequestException', async () => {
    hashMock.mockRejectedValueOnce(new Error('boom'));
    await expect(hashData('secret')).rejects.toThrow(BadRequestException);
    await expect(hashData('secret')).resolves.toMatch(/^\$2/);
  });

  it('does not put the cause of a hashing failure in the response', async () => {
    hashMock.mockRejectedValueOnce(new Error('secret-value-in-message'));
    const error = await hashData('secret').catch((e: BadRequestException) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe('Failed to hash data');
  });

  it('treats a hash bcrypt cannot read as "no match" instead of throwing', async () => {
    compareMock.mockRejectedValueOnce(new Error('malformed hash'));
    await expect(compareData('secret', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });

  it('honours BCRYPT_ROUNDS within 10..15', async () => {
    const previous = process.env.BCRYPT_ROUNDS;
    try {
      process.env.BCRYPT_ROUNDS = '4';
      await hashData('x');
      expect(hashMock).toHaveBeenLastCalledWith('x', 10);
      process.env.BCRYPT_ROUNDS = 'nope';
      await hashData('x');
      expect(hashMock).toHaveBeenLastCalledWith('x', 12);
    } finally {
      if (previous === undefined) delete process.env.BCRYPT_ROUNDS;
      else process.env.BCRYPT_ROUNDS = previous;
    }
  });
});
