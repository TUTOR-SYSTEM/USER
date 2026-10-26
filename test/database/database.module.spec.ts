import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { DatabaseModule, PrismaService } from 'src/database/database.module';

jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: jest.fn(() => ({ __adapter: true })) }));

const mockConnect = jest.fn();
const mockQueryRaw = jest.fn();
const mockDisconnect = jest.fn();

jest.mock('src/generated/prisma/client', () => ({
  PrismaClient: class {
    $connect = (...args: unknown[]) => mockConnect(...args);
    $queryRaw = (...args: unknown[]) => mockQueryRaw(...args);
    $disconnect = (...args: unknown[]) => mockDisconnect(...args);
  },
}));

const POSTGRES_ENVS = {
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5432',
  POSTGRES_DB: 'tutordb',
  POSTGRES_USER: 'tutor',
  POSTGRES_PASSWORD: 'p@ss',
};

/** Exposes a ConfigService to DatabaseModule (it is resolved from the global scope). */
function configModuleFor(values: Record<string, string | undefined>) {
  @Global()
  @Module({
    providers: [
      {
        provide: ConfigService,
        useValue: { get: (key: string) => values[key], getOrThrow: (key: string) => values[key] },
      },
    ],
    exports: [ConfigService],
  })
  class StubConfigModule {}
  return StubConfigModule;
}

async function compileWith(values: Record<string, string | undefined>) {
  const moduleRef = await Test.createTestingModule({
    imports: [configModuleFor(values), DatabaseModule],
  }).compile();
  // onModuleInit (the connection check) only runs on init, not on compile.
  await moduleRef.init();
  return moduleRef;
}

describe('DatabaseModule', () => {
  const mockedAdapter = PrismaPg as unknown as jest.Mock;
  const realSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedAdapter.mockClear();
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockQueryRaw.mockReset().mockResolvedValue([]);
    mockDisconnect.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Skip the 2s retry delay without skipping any other timer. */
  const runRetryDelaysImmediately = () =>
    jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
        ms === 2000 ? (fn(), 0) : realSetTimeout(fn, ms, ...rest)) as unknown as typeof setTimeout);

  it('connects with DATABASE_URL when it is set and exposes PrismaService', async () => {
    const moduleRef = await compileWith({ DATABASE_URL: 'postgres://u:pw@db.internal:5432/app' });

    expect(mockedAdapter).toHaveBeenCalledWith({
      connectionString: 'postgres://u:pw@db.internal:5432/app',
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    expect(moduleRef.get(PrismaService)).toBeInstanceOf(PrismaService);
    await moduleRef.close();
  });

  it('builds the connection URL from POSTGRES_* and URL-encodes the credentials', async () => {
    const moduleRef = await compileWith({ ...POSTGRES_ENVS, DATABASE_URL: '   ' });

    expect(mockedAdapter).toHaveBeenCalledWith({
      connectionString: 'postgres://tutor:p%40ss@localhost:5432/tutordb',
    });
    await moduleRef.close();
  });

  it('refuses to start when neither DATABASE_URL nor the POSTGRES_* variables are complete', async () => {
    await expect(compileWith({ ...POSTGRES_ENVS, POSTGRES_PASSWORD: '' })).rejects.toThrow(
      'Missing required environment variables:\n- POSTGRES_PASSWORD',
    );
    expect(mockedAdapter).not.toHaveBeenCalled();
  });

  it('retries the initial connection and succeeds on a later attempt', async () => {
    mockConnect.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(undefined);
    runRetryDelaysImmediately();

    const moduleRef = await compileWith({ DATABASE_URL: 'postgres://x' });

    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/3 failed: ECONNREFUSED'),
    );
    await moduleRef.close();
  });

  it('gives up after 3 failed attempts with a PostgreSQL connect failure', async () => {
    mockConnect.mockRejectedValue(new Error('down'));
    runRetryDelaysImmediately();

    await expect(compileWith({ DATABASE_URL: 'postgres://x' })).rejects.toThrow(
      'PostgreSQL connect failed',
    );

    expect(mockConnect).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.error).toHaveBeenCalledWith('❌ PostgreSQL connect failed.');
  });

  it('closes the connection pool on application shutdown', async () => {
    const moduleRef = await compileWith({ DATABASE_URL: 'postgres://x' });
    await moduleRef.close();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});
