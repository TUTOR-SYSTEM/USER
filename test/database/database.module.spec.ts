import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DatabaseModule, DRIZZLE } from 'src/database/database.module';

jest.mock('postgres', () => jest.fn());
jest.mock('drizzle-orm/postgres-js', () => ({ drizzle: jest.fn(() => ({ __drizzle: true })) }));

type FakeClient = jest.Mock & { end: jest.Mock };

/** postgres.js client is a tagged-template function that also exposes `end()`. */
function fakeClient(queryImpl: () => Promise<unknown> = async () => []): FakeClient {
  const tag = jest.fn(queryImpl) as FakeClient;
  tag.end = jest.fn().mockResolvedValue(undefined);
  return tag;
}

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
  return Test.createTestingModule({
    imports: [configModuleFor(values), DatabaseModule],
  }).compile();
}

describe('DatabaseModule', () => {
  const mockedPostgres = postgres as unknown as jest.Mock;
  const mockedDrizzle = drizzle as unknown as jest.Mock;
  const realSetTimeout = global.setTimeout;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockedDrizzle.mockClear();
    mockedPostgres.mockClear();
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

  it('connects with DATABASE_URL when it is set and exposes the drizzle instance', async () => {
    const client = fakeClient();
    mockedPostgres.mockReturnValue(client);

    const moduleRef = await compileWith({ DATABASE_URL: 'postgres://u:pw@db.internal:5432/app' });

    expect(mockedPostgres).toHaveBeenCalledWith('postgres://u:pw@db.internal:5432/app');
    expect(client).toHaveBeenCalledTimes(1);
    expect(mockedDrizzle).toHaveBeenCalledWith(client, { schema: expect.any(Object) });
    expect(moduleRef.get(DRIZZLE)).toEqual({ __drizzle: true });
  });

  it('builds the connection URL from POSTGRES_* and URL-encodes the credentials', async () => {
    mockedPostgres.mockReturnValue(fakeClient());

    await compileWith({ ...POSTGRES_ENVS, DATABASE_URL: '   ' });

    expect(mockedPostgres).toHaveBeenCalledWith('postgres://tutor:p%40ss@localhost:5432/tutordb');
  });

  it('refuses to start when neither DATABASE_URL nor the POSTGRES_* variables are complete', async () => {
    mockedPostgres.mockReturnValue(fakeClient());

    await expect(compileWith({ ...POSTGRES_ENVS, POSTGRES_PASSWORD: '' })).rejects.toThrow(
      'Missing required environment variables:\n- POSTGRES_PASSWORD',
    );
    expect(mockedPostgres).not.toHaveBeenCalled();
  });

  it('retries the initial SELECT and succeeds on a later attempt', async () => {
    const client = fakeClient()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce([]);
    mockedPostgres.mockReturnValue(client);
    runRetryDelaysImmediately();

    await compileWith({ DATABASE_URL: 'postgres://x' });

    expect(client).toHaveBeenCalledTimes(2);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt 1/3 failed: ECONNREFUSED'),
    );
    expect(mockedDrizzle).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 failed attempts with a PostgreSQL connect failure', async () => {
    const client = fakeClient().mockRejectedValue(new Error('down'));
    mockedPostgres.mockReturnValue(client);
    runRetryDelaysImmediately();

    await expect(compileWith({ DATABASE_URL: 'postgres://x' })).rejects.toThrow(
      'PostgreSQL connect failed',
    );

    expect(client).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(3);
    expect(Logger.prototype.error).toHaveBeenCalledWith('❌ PostgreSQL connect failed.');
    expect(mockedDrizzle).not.toHaveBeenCalled();
  });

  it('closes the connection pool on application shutdown', async () => {
    const client = fakeClient();
    mockedPostgres.mockReturnValue(client);

    const moduleRef = await compileWith({ DATABASE_URL: 'postgres://x' });
    await moduleRef.close();

    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
  });
});
