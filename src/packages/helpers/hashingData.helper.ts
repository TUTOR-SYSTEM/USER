import { BadRequestException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

const logger = new Logger('HashingData');

/** bcrypt cost. 12 by default; `BCRYPT_ROUNDS` can raise it (never below 10). Old hashes keep verifying. */
const DEFAULT_BCRYPT_ROUNDS = 12;
const MIN_BCRYPT_ROUNDS = 10;
const MAX_BCRYPT_ROUNDS = 15;

function saltRounds(): number {
  const parsed = Number(process.env.BCRYPT_ROUNDS);
  if (!Number.isInteger(parsed)) return DEFAULT_BCRYPT_ROUNDS;
  return Math.min(MAX_BCRYPT_ROUNDS, Math.max(MIN_BCRYPT_ROUNDS, parsed));
}

export async function hashData(data: string): Promise<string> {
  try {
    return await bcrypt.hash(data, saltRounds());
  } catch (error) {
    // The cause can echo the input: log it, never put it in the response.
    logger.error('Failed to hash data', error instanceof Error ? error.stack : String(error));
    throw new BadRequestException('Failed to hash data');
  }
}

/**
 * True only for a matching hash. A hash that bcrypt cannot read counts as "no match" (fail closed):
 * throwing here would answer 400 instead of 401, and a failed sign-in would not be counted.
 */
export async function compareData(data: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(data, hash);
  } catch (error) {
    logger.warn(`Could not verify data against the stored hash: ${(error as Error).message}`);
    return false;
  }
}
