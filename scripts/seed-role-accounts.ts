/**
 * Seed one account per role (TUTOR / STUDENT / PARENT) with the same password.
 *
 * Usage: bun scripts/seed-role-accounts.ts
 * Shared password: Admin123@ (override with SEED_PASSWORD)
 * STUDENT and PARENT get a 6-character `userCode` so they can use code login.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from './lib/prisma';
import { hashData } from '../src/packages/helpers/hashingData.helper';

const DEFAULT_PASSWORD = 'Admin123@';

const SEED_ACCOUNTS = [
  {
    email: 'tutor@example.com',
    username: 'tutor',
    firstName: 'Tutor',
    lastName: 'Account',
    role: 'TUTOR' as const,
  },
  {
    email: 'student@example.com',
    username: 'student',
    firstName: 'Student',
    lastName: 'Account',
    userCode: 'STU001',
    role: 'STUDENT' as const,
  },
  {
    email: 'parent@example.com',
    username: 'parent',
    firstName: 'Parent',
    lastName: 'Account',
    userCode: 'PAR001',
    role: 'PARENT' as const,
  },
] satisfies Array<{
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  userCode?: string;
  role: 'STUDENT' | 'PARENT' | 'TUTOR';
}>;

async function main(): Promise<void> {
  const password = process.env.SEED_PASSWORD?.trim() || DEFAULT_PASSWORD;
  if (password.length < 8) {
    console.error('SEED_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const db = createPrismaClient();
  const hashedPassword = await hashData(password);

  for (const account of SEED_ACCOUNTS) {
    const existing = await db.user.findFirst({
      where: { email: { equals: account.email, mode: 'insensitive' } },
      select: { id: true },
    });

    if (existing) {
      await db.user.update({
        where: { id: existing.id },
        data: {
          password: hashedPassword,
          role: account.role,
          userCode: account.userCode ?? null,
          isActive: true,
          emailVerified: true,
        },
      });
      console.log(`Updated [${account.role}]: ${account.email}`);
      continue;
    }

    const usernameTaken = await db.user.findUnique({
      where: { username: account.username },
      select: { id: true },
    });
    if (usernameTaken) {
      console.error(`Username already taken, skipped: ${account.username}`);
      continue;
    }

    await db.user.create({
      data: {
        id: randomUUID(),
        email: account.email,
        username: account.username,
        firstName: account.firstName,
        lastName: account.lastName,
        password: hashedPassword,
        role: account.role,
        userCode: account.userCode,
        isActive: true,
        emailVerified: true,
      },
    });
    console.log(
      `Created [${account.role}]: ${account.email}` +
        (account.userCode ? ` (userCode: ${account.userCode})` : ''),
    );
  }

  console.log(`\nShared password: ${password}`);
  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
