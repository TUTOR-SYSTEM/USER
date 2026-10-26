import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client';

function resolveDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return databaseUrl;
  }

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

/** Prisma client for the seed scripts, using the same URL resolution they always had. */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveDatabaseUrl() }) });
}
