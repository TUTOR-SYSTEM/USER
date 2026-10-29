import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from './lib/prisma';
import { hashData } from '../src/packages/helpers/hashingData.helper';

const SEED_ACCOUNTS = [
  {
    email: 'dang04223@gmail.com',
    username: 'admin',
    firstName: 'Admin',
    lastName: 'Account',
    password: 'Admin@123456',
    role: 'ADMIN' as const,
  },
  {
    email: 'chienbinhthephai@gmail.com',
    username: 'tutor',
    firstName: 'Tutor',
    lastName: 'Account',
    password: 'Tutor@123456',
    role: 'TUTOR' as const,
  },
  {
    email: 'student@finance.dev',
    username: 'student',
    firstName: 'Student',
    lastName: 'Account',
    password: 'Student@123456',
    userCode: 'ABC123',
    role: 'STUDENT' as const,
  },
  {
    email: 'parent@finance.dev',
    username: 'parent',
    firstName: 'Parent',
    lastName: 'Account',
    userCode: 'ABC456',
    password: 'Parent@123456',
    role: 'PARENT' as const,
  },
] satisfies Array<{
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
  userCode?: string;
  role: 'ADMIN' | 'STUDENT' | 'PARENT' | 'TUTOR';
}>;

async function main(): Promise<void> {
  const db = createPrismaClient();

  for (const account of SEED_ACCOUNTS) {
    const existing = await db.user.findFirst({
      where: { email: { equals: account.email, mode: 'insensitive' } },
      select: { id: true, userCode: true },
    });

    if (existing) {
      if (account.userCode && existing.userCode !== account.userCode) {
        await db.user.update({
          where: { id: existing.id },
          data: { userCode: account.userCode },
        });
        console.log(`Updated userCode (${account.userCode}): ${account.email}`);
        continue;
      }
      console.log(`Skipped (already exists): ${account.email}`);
      continue;
    }

    const usernameTaken = await db.user.findUnique({
      where: { username: account.username },
      select: { id: true },
    });

    if (usernameTaken) {
      console.error(`Username already taken: ${account.username}`);
      continue;
    }

    const hashedPassword = await hashData(account.password);
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
      },
    });

    console.log(`Created [${account.role}]: ${account.email} (username: ${account.username})`);
  }

  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
