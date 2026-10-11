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
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hashMock).toHaveBeenCalledWith('secret', 10);
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

  it('wraps a compare failure in BadRequestException', async () => {
    compareMock.mockRejectedValueOnce(new Error('malformed hash'));
    await expect(compareData('secret', 'not-a-bcrypt-hash')).rejects.toMatchObject({
      message: expect.stringContaining('Failed to verify data: Error: malformed hash'),
    });
  });
});
