import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ClientProxy, RmqRecord } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { EMPTY, NEVER, of, throwError } from 'rxjs';
import {
  CORRELATION_ID_HEADER,
  PARENT_TRACE_ID_HEADER,
  runWithRequestContext,
  SERVICE_NAME_HEADER,
  TRACE_ID_HEADER,
} from 'src/packages/context/request-context';
import {
  resolveRmqTarget,
  RMQ_PATTERN_ROUTES,
  RMQ_PREFIX_ROUTES,
  TUTOR_SERVICE,
  THIRD_SERVICE,
  USER_SERVICE,
} from 'src/features/rabbitmq/rmq.constants';
import { RmqProducer } from 'src/features/rabbitmq/rmq.producer';

type FakeClient = {
  send: jest.Mock;
  emit: jest.Mock;
  close: jest.Mock;
};

const fakeClient = (): FakeClient => ({
  send: jest.fn(() => of({ ok: true })),
  emit: jest.fn(() => of(undefined)),
  close: jest.fn(() => Promise.resolve()),
});

describe('resolveRmqTarget', () => {
  it('routes known prefixes to their owning queue', () => {
    expect(resolveRmqTarget('auth.login')).toBe(USER_SERVICE);
    expect(resolveRmqTarget('user.getUserById')).toBe(USER_SERVICE);
    expect(resolveRmqTarget('email.send')).toBe(THIRD_SERVICE);
    expect(resolveRmqTarget('upload.file')).toBe(THIRD_SERVICE);
    expect(resolveRmqTarget('class.create')).toBe(TUTOR_SERVICE);
    expect(resolveRmqTarget('ai.chat')).toBe(TUTOR_SERVICE);
  });

  it('prefers a full-pattern override over its prefix', () => {
    expect(RMQ_PREFIX_ROUTES.kafka).toBe(USER_SERVICE);
    expect(resolveRmqTarget('kafka.tutor')).toBe(TUTOR_SERVICE);
    expect(resolveRmqTarget('health.postgres')).toBe(USER_SERVICE);
    expect(resolveRmqTarget('health.redis')).toBe(THIRD_SERVICE);
  });

  it('uses only the first dot segment for prefix routing', () => {
    expect(resolveRmqTarget('auth.a.b.c')).toBe(USER_SERVICE);
  });

  it('throws a descriptive error for an unrouted pattern', () => {
    expect(() => resolveRmqTarget('unknown.thing')).toThrow(
      'No RabbitMQ route for pattern "unknown.thing"',
    );
  });

  it('keeps every override target inside the known target set', () => {
    const targets = new Set([USER_SERVICE, TUTOR_SERVICE, THIRD_SERVICE]);
    for (const target of [
      ...Object.values(RMQ_PATTERN_ROUTES),
      ...Object.values(RMQ_PREFIX_ROUTES),
    ]) {
      expect(targets.has(target)).toBe(true);
    }
  });
});

describe('RmqProducer', () => {
  let producer: RmqProducer;
  let user: FakeClient;
  let tutor: FakeClient;
  let third: FakeClient;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    user = fakeClient();
    tutor = fakeClient();
    third = fakeClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RmqProducer,
        { provide: USER_SERVICE, useValue: user as unknown as ClientProxy },
        { provide: TUTOR_SERVICE, useValue: tutor as unknown as ClientProxy },
        { provide: THIRD_SERVICE, useValue: third as unknown as ClientProxy },
      ],
    }).compile();
    producer = moduleRef.get(RmqProducer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('emit', () => {
    it('sends to the routed client and resolves with its value', async () => {
      tutor.emit.mockReturnValueOnce(of('emitted'));
      await expect(producer.emit('class.created', { id: 1 })).resolves.toBe('emitted');
      expect(tutor.emit).toHaveBeenCalledWith('class.created', expect.any(RmqRecord));
      expect(user.emit).not.toHaveBeenCalled();
    });

    it('resolves undefined when the observable completes empty (fire-and-forget)', async () => {
      tutor.emit.mockReturnValueOnce(EMPTY);
      await expect(producer.emit('class.created', {})).resolves.toBeUndefined();
    });

    it('wraps the payload so the handler still receives the original object', async () => {
      await producer.emit('auth.logout', { sub: 'u1' });
      const record = tutor.emit.mock.calls[0]?.[1] ?? user.emit.mock.calls[0]?.[1];
      expect(record).toBeInstanceOf(RmqRecord);
      expect((record as RmqRecord<{ sub: string }>).data).toEqual({ sub: 'u1' });
    });
  });

  describe('trace headers', () => {
    it('reuses the request correlationId, sets a fresh traceId, and links the parent', async () => {
      await runWithRequestContext(
        { correlationId: 'corr-1', traceId: 'parent-hop', serviceName: 'gateway' },
        () => producer.emit('auth.logout', {}),
      );
      const record = user.emit.mock.calls[0][1] as RmqRecord<unknown>;
      const headers = record.options.headers as Record<string, string>;
      expect(headers[CORRELATION_ID_HEADER]).toBe('corr-1');
      expect(headers[PARENT_TRACE_ID_HEADER]).toBe('parent-hop');
      expect(headers[TRACE_ID_HEADER]).toEqual(expect.any(String));
      expect(headers[TRACE_ID_HEADER]).not.toBe('parent-hop');
      expect(headers[SERVICE_NAME_HEADER]).toBe('user-service');
    });

    it('generates a correlationId and empty parent when there is no request context', async () => {
      await producer.emit('auth.logout', {});
      const headers = (user.emit.mock.calls[0][1] as RmqRecord<unknown>).options.headers as Record<
        string,
        string
      >;
      expect(headers[CORRELATION_ID_HEADER]).toEqual(expect.any(String));
      expect(headers[CORRELATION_ID_HEADER].length).toBeGreaterThan(0);
      expect(headers[PARENT_TRACE_ID_HEADER]).toBe('');
    });
  });

  describe('send', () => {
    it('returns the responder value on first success', async () => {
      user.send.mockReturnValueOnce(of({ id: 'u1' }));
      await expect(producer.send('user.getUserById', { id: 'u1' })).resolves.toEqual({ id: 'u1' });
      expect(user.send).toHaveBeenCalledTimes(1);
    });

    it('retries after a failure and succeeds on a later attempt', async () => {
      user.send
        .mockReturnValueOnce(throwError(() => new Error('transient')))
        .mockReturnValueOnce(of('ok'));
      await expect(producer.send('user.getUserById', {})).resolves.toBe('ok');
      expect(user.send).toHaveBeenCalledTimes(2);
    });

    it('makes maxRetries + 1 attempts before failing', async () => {
      user.send.mockReturnValue(throwError(() => new Error('down')));
      await expect(producer.send('user.getUserById', {}, 1000, 2)).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(user.send).toHaveBeenCalledTimes(3);
    }, 10000);

    it('uses maxRetries 0 for a single attempt', async () => {
      user.send.mockReturnValue(throwError(() => new Error('down')));
      await expect(producer.send('user.getUserById', {}, 1000, 0)).rejects.toThrow(HttpException);
      expect(user.send).toHaveBeenCalledTimes(1);
    });

    it('maps a timeout to 504 with isTimeout set', async () => {
      user.send.mockReturnValue(NEVER);
      const err = await producer
        .send('user.getUserById', {}, 10, 0)
        .catch((e: unknown) => e as HttpException);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect((err as HttpException).getResponse()).toMatchObject({
        isTimeout: true,
        attempts: 1,
      });
    });

    it('propagates the responder status and message on final failure', async () => {
      user.send.mockReturnValue(
        throwError(() => ({ statusCode: HttpStatus.NOT_FOUND, message: 'User not found ...' })),
      );
      const err = await producer
        .send('user.getUserById', {}, 1000, 0)
        .catch((e: unknown) => e as HttpException);
      expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(err.getResponse()).toMatchObject({
        message: 'User not found ...',
        isTimeout: false,
        attempts: 1,
      });
    });

    it('turns a plain Error into a 500 carrying its message', async () => {
      user.send.mockReturnValue(throwError(() => new Error('kaboom')));
      const err = await producer
        .send('user.getUserById', {}, 1000, 0)
        .catch((e: unknown) => e as HttpException);
      expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(err.getResponse()).toMatchObject({ message: 'kaboom' });
    });

    it('stringifies a connection-shaped error object so the real cause is visible', async () => {
      user.send.mockReturnValue(throwError(() => ({ err: {}, url: 'amqp://bad' })));
      const err = await producer
        .send('user.getUserById', {}, 1000, 0)
        .catch((e: unknown) => e as HttpException);
      expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect((err.getResponse() as { message: string }).message).toBe(
        JSON.stringify({ err: {}, url: 'amqp://bad' }),
      );
    });

    it('treats an error object without a string message as a transport failure (500, JSON body)', async () => {
      // Current behaviour: the status on a message-less payload is discarded, so a 502 becomes 500.
      user.send.mockReturnValue(throwError(() => ({ statusCode: 502 })));
      const err = await producer
        .send('user.getUserById', {}, 1000, 0)
        .catch((e: unknown) => e as HttpException);
      expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect((err.getResponse() as { message: string }).message).toBe(
        JSON.stringify({ statusCode: 502 }),
      );
    });

    it('routes the send to the client that owns the pattern', async () => {
      tutor.send.mockReturnValueOnce(of('t'));
      await expect(producer.send('report.summary', {})).resolves.toBe('t');
      expect(tutor.send).toHaveBeenCalledTimes(1);
      expect(user.send).not.toHaveBeenCalled();
    });

    it('rejects an unknown pattern before any network call', async () => {
      await expect(producer.send('nope.nope', {})).rejects.toThrow('No RabbitMQ route');
      expect(user.send).not.toHaveBeenCalled();
      expect(tutor.send).not.toHaveBeenCalled();
      expect(third.send).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('closes all three clients', async () => {
      await producer.onModuleDestroy();
      expect(user.close).toHaveBeenCalledTimes(1);
      expect(tutor.close).toHaveBeenCalledTimes(1);
      expect(third.close).toHaveBeenCalledTimes(1);
    });
  });
});

describe('RmqProducer.send error payload shapes', () => {
  let producer: RmqProducer;
  let user: FakeClient;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    user = fakeClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RmqProducer,
        { provide: USER_SERVICE, useValue: user as unknown as ClientProxy },
        { provide: TUTOR_SERVICE, useValue: fakeClient() as unknown as ClientProxy },
        { provide: THIRD_SERVICE, useValue: fakeClient() as unknown as ClientProxy },
      ],
    }).compile();
    producer = moduleRef.get(RmqProducer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const failWith = () =>
    producer.send('user.getUserById', {}, 1000, 0).catch((e: unknown) => e as HttpException);

  it('keeps an array message from the responder and joins it in the failure log', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    user.send.mockReturnValue(
      throwError(() => ({
        statusCode: HttpStatus.BAD_REQUEST,
        message: ['name is required', 'email is invalid'],
      })),
    );

    const err = await failWith();

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.getResponse()).toMatchObject({ message: ['name is required', 'email is invalid'] });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('name is required, email is invalid'),
    );
  });

  it('defaults to 500 when the responder error has a message but no statusCode', async () => {
    user.send.mockReturnValue(throwError(() => ({ message: 'no status here' })));

    const err = await failWith();

    expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(err.getResponse()).toMatchObject({ message: 'no status here' });
  });

  it('stringifies a non-Error primitive rejection into the message', async () => {
    user.send.mockReturnValue(throwError(() => 'plain string failure'));

    const err = await failWith();

    expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(err.getResponse()).toMatchObject({ message: 'plain string failure' });
  });

  it('stringifies a null rejection instead of crashing on the payload', async () => {
    user.send.mockReturnValue(throwError(() => null));

    const err = await failWith();

    expect(err.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(err.getResponse()).toMatchObject({ message: 'null' });
  });

  it('passes through errors/serviceName from the responder payload', async () => {
    user.send.mockReturnValue(
      throwError(() => ({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        message: 'bad',
        errors: { field: 'email' },
        serviceName: 'user-service',
      })),
    );

    const err = await failWith();

    expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(err.getResponse()).toMatchObject({
      errors: { field: 'email' },
      serviceName: 'user-service',
    });
  });
});
