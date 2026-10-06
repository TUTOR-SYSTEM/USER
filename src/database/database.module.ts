import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';
import { validateRequiredEnvs } from '@packages/helpers';

// esModuleInterop wraps the schema in a null-prototype `default` namespace that drizzle's is() chokes on.
const tables = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'default'));

export const DRIZZLE = 'DRIZZLE';
const PG_CLIENT = 'PG_CLIENT';
export const DATABASE_ENVS = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
] as const;
@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Nếu không dùng DATABASE_URL thì validate từng biến
        const databaseUrl = configService.get<string>('DATABASE_URL')?.trim();

        if (!databaseUrl) {
          validateRequiredEnvs(configService, DATABASE_ENVS);
        }

        const connectionString =
          databaseUrl ||
          (() => {
            const url = new URL(
              `postgres://${configService.getOrThrow('POSTGRES_HOST')}:${configService.getOrThrow(
                'POSTGRES_PORT',
              )}/${configService.getOrThrow('POSTGRES_DB')}`,
            );

            url.username = configService.getOrThrow('POSTGRES_USER');
            url.password = configService.getOrThrow('POSTGRES_PASSWORD');

            return url.toString();
          })();

        return postgres(connectionString);
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_CLIENT],
      useFactory: async (client: ReturnType<typeof postgres>) => {
        const logger = new Logger(DatabaseModule.name);
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await client`SELECT 1`;
            logger.log('✅ PostgreSQL connected.');
            return drizzle(client, { schema: tables });
          } catch (error) {
            logger.warn(
              `PostgreSQL connection attempt ${attempt}/${MAX_RETRIES} failed: ${
                (error as Error).message
              }`,
            );

            if (attempt === MAX_RETRIES) {
              logger.error('❌ PostgreSQL connect failed.');
              throw new Error('PostgreSQL connect failed');
            }

            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          }
        }
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_CLIENT) private readonly client: ReturnType<typeof postgres>) {}

  async onApplicationShutdown() {
    await this.client.end({ timeout: 5 });
  }
}
