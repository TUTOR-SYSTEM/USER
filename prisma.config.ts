import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const {
  DATABASE_URL,
  POSTGRES_HOST,
  POSTGRES_PORT,
  POSTGRES_DB,
  POSTGRES_USER,
  POSTGRES_PASSWORD,
} = process.env;

// Same resolution order as DatabaseModule: DATABASE_URL, else the discrete POSTGRES_* vars.
const url =
  DATABASE_URL?.trim() ||
  (POSTGRES_HOST
    ? `postgres://${encodeURIComponent(POSTGRES_USER ?? '')}:${encodeURIComponent(
        POSTGRES_PASSWORD ?? '',
      )}@${POSTGRES_HOST}:${POSTGRES_PORT ?? 5432}/${POSTGRES_DB}`
    : 'postgres://placeholder:placeholder@localhost:5432/placeholder'); // `generate` needs no connection

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url },
});
