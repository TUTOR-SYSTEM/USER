import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { validateRequiredEnvs } from '@packages/helpers';
import { PrismaClient } from '../generated/prisma/client';

export const DATABASE_ENVS = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_DB',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
] as const;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function resolveConnectionString(configService: ConfigService): string {
  // Nếu không dùng DATABASE_URL thì validate từng biến
  const databaseUrl = configService.get<string>('DATABASE_URL')?.trim();
  if (databaseUrl) return databaseUrl;

  validateRequiredEnvs(configService, DATABASE_ENVS);

  const url = new URL(
    `postgres://${configService.getOrThrow('POSTGRES_HOST')}:${configService.getOrThrow(
      'POSTGRES_PORT',
    )}/${configService.getOrThrow('POSTGRES_DB')}`,
  );
  url.username = configService.getOrThrow('POSTGRES_USER');
  url.password = configService.getOrThrow('POSTGRES_PASSWORD');

  return url.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    super({ adapter: new PrismaPg({ connectionString: resolveConnectionString(configService) }) });
  }

  async onModuleInit() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.$connect();
        await this.$queryRaw`SELECT 1`;
        this.logger.log('✅ PostgreSQL connected.');
        return;
      } catch (error) {
        this.logger.warn(
          `PostgreSQL connection attempt ${attempt}/${MAX_RETRIES} failed: ${
            (error as Error).message
          }`,
        );

        if (attempt === MAX_RETRIES) {
          this.logger.error('❌ PostgreSQL connect failed.');
          throw new Error('PostgreSQL connect failed');
        }

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
