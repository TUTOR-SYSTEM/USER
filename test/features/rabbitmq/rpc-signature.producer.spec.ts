import { of } from 'rxjs';
import { RmqRecord } from '@nestjs/microservices';
import { verifyRpcSignature } from '@packages/helpers/rpc-signature.helper';
import { RmqProducer } from '../../../src/features/rabbitmq/rmq.producer';

const SECRET = 'x'.repeat(40);

function makeClient() {
  return { send: jest.fn(() => of('ok')), emit: jest.fn(() => of(undefined)), close: jest.fn() };
}

/** Data of the RmqRecord the producer handed to the client. */
function dataOf(call: unknown[]): Record<string, unknown> {
  return (call[1] as RmqRecord<Record<string, unknown>>).data;
}

describe('RmqProducer rpcSig signing (report F-01, F-07)', () => {
  let user: ReturnType<typeof makeClient>;
  let tutor: ReturnType<typeof makeClient>;
  let third: ReturnType<typeof makeClient>;
  let producer: RmqProducer;

  beforeEach(() => {
    process.env.RPC_ACTOR_SECRET = SECRET;
    user = makeClient();
    tutor = makeClient();
    third = makeClient();
    producer = new RmqProducer(user as never, tutor as never, third as never);
  });

  afterEach(() => {
    delete process.env.RPC_ACTOR_SECRET;
  });

  it('signs a redis.set on a sensitive key and the MAC verifies', async () => {
    await producer.send('redis.set', { key: 'reset-password-otp:u1', value: '123' });
    const data = dataOf(third.send.mock.calls[0]);
    expect(typeof data.rpcSig).toBe('string');
    expect(verifyRpcSignature('redis.set', data, SECRET)).toBe(true);
  });

  it('signs email.* messages', async () => {
    await producer.send('email.sendVerifyEmail', { to: 'a@b.test' });
    expect(
      verifyRpcSignature('email.sendVerifyEmail', dataOf(third.send.mock.calls[0]), SECRET),
    ).toBe(true);
  });

  it('signs a redis.del emit on a revoked-* key', () => {
    producer.emit('redis.del', { keys: ['revoked-all:u1'] });
    expect(verifyRpcSignature('redis.del', dataOf(third.emit.mock.calls[0]), SECRET)).toBe(true);
  });

  it('leaves non-sensitive and session-read messages unsigned', async () => {
    await producer.send('redis.set', { key: 'cache:x', value: 'v' });
    await producer.send('redis.get', { key: 'session:u1:s1' });
    expect(dataOf(third.send.mock.calls[0]).rpcSig).toBeUndefined();
    expect(dataOf(third.send.mock.calls[1]).rpcSig).toBeUndefined();
  });

  it('refuses to send a sensitive message without RPC_ACTOR_SECRET', async () => {
    delete process.env.RPC_ACTOR_SECRET;
    await expect(producer.send('email.test', {})).rejects.toThrow('RPC_ACTOR_SECRET must be set');
    expect(third.send).not.toHaveBeenCalled();
  });
});
