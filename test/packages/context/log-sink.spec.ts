import { emitRequestLog, RequestLogEntry, setLogSink } from 'src/packages/context/log-sink';

describe('emitRequestLog', () => {
  const entry = {
    serviceName: 'user-service',
    type: 'RPC',
    path: 'user.x',
  } as unknown as RequestLogEntry;

  // The sink is module-level state; reset it so later suites are not affected.
  afterEach(() => {
    setLogSink(() => undefined);
  });

  it('forwards the entry to the registered sink', () => {
    const sink = jest.fn();
    setLogSink(sink);
    emitRequestLog(entry);
    expect(sink).toHaveBeenCalledWith(entry);
  });

  it('does nothing when no sink has been registered', () => {
    expect(() => {
      setLogSink(undefined as unknown as Parameters<typeof setLogSink>[0]);
      emitRequestLog(entry);
    }).not.toThrow();
  });

  it('swallows a sink that throws synchronously', () => {
    setLogSink(() => {
      throw new Error('sink down');
    });
    expect(() => emitRequestLog(entry)).not.toThrow();
  });

  it('swallows a sink that returns a rejected promise', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      setLogSink(() => Promise.reject(new Error('async sink down')));
      emitRequestLog(entry);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
