#!/usr/bin/env bun
/**
 * Drop all tables + enums, recreate from schema, seed test users.
 *
 * Usage: bun scripts/recreate-db.ts
 */
import 'dotenv/config';
import postgres from 'postgres';
import { execSync } from 'node:child_process';

function resolveDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return databaseUrl;

  const host = process.env.POSTGRES_HOST?.trim() || 'localhost';
  const port = process.env.POSTGRES_PORT?.trim() || '5433';
  const db = process.env.POSTGRES_DB?.trim() || 'backends_db';
  const user = process.env.POSTGRES_USER?.trim() || 'postgres';
  const password = process.env.POSTGRES_PASSWORD?.trim() || 'postgres';

  const url = new URL(`postgres://${host}:${port}/${db}`);
  url.username = user;
  url.password = password;
  return url.toString();
}

async function main(): Promise<void> {
  const url = resolveDatabaseUrl();
  const sql = postgres(url);

  console.log('Dropping all tables…');
  // Drop tables with CASCADE to remove FK dependencies
  const tables = await sql<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `;
  for (const t of tables) {
    await sql.unsafe(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`);
  }
  console.log(`  Dropped ${tables.length} table(s)`);

  // Drop all custom enum types
  const enums = await sql<Array<{ typname: string }>>`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'
  `;
  for (const e of enums) {
    await sql.unsafe(`DROP TYPE IF EXISTS "${e.typname}" CASCADE`);
  }
  console.log(`  Dropped ${enums.length} enum(s)`);

  await sql.end({ timeout: 5 });

  // Push schema via prisma
  console.log('\nPushing schema via prisma…');
  execSync('bun x prisma db push --accept-data-loss', {
    stdio: 'inherit',
  });

  // Seed users
  console.log('\nSeeding users…');
  execSync('bun scripts/seed-user.ts', {
    stdio: 'inherit',
  });

  console.log('\nDone. Database recreated and seeded.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
