#!/usr/bin/env bun
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient } from './lib/prisma';

async function main(): Promise<void> {
  const db = createPrismaClient();

  for (let level = 1; level <= 12; level++) {
    const name = `Lớp ${level}`;

    const existing = await db.grade.findUnique({ where: { level }, select: { id: true } });
    if (existing) {
      console.log(`Skipped (already exists): ${name}`);
      continue;
    }

    await db.grade.create({ data: { id: randomUUID(), name, level } });
    console.log(`Created: ${name}`);
  }

  await db.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
