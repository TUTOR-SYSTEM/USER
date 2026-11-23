import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const {
  POSTGRES_HOST = '127.0.0.1',
  POSTGRES_PORT = '5432',
  POSTGRES_DB = 'backends_db',
  POSTGRES_USER = 'postgres',
  POSTGRES_PASSWORD,
} = process.env;

if (!POSTGRES_PASSWORD) {
  throw new Error('POSTGRES_PASSWORD is required');
}

const url = `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
  POSTGRES_PASSWORD,
)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${encodeURIComponent(POSTGRES_DB)}`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url,
  },
});
