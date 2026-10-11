/**
 * Thenable stand-in for a drizzle query builder. Every builder method returns the same chain,
 * and awaiting the chain resolves to the next queued result. Each `select`/`insert`/`update`/
 * `delete` call consumes one entry from `results`, in call order.
 */
const BUILDER_METHODS = [
  'select',
  'from',
  'where',
  'limit',
  'offset',
  'orderBy',
  'leftJoin',
  'values',
  'set',
  'returning',
] as const;

export function makeDrizzleMock(results: unknown[]) {
  const queue = [...results];
  const next = () => {
    const chain: Record<string, unknown> = {};
    for (const method of BUILDER_METHODS) chain[method] = jest.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift()).then(resolve, reject);
    return chain;
  };
  const calls = {
    select: jest.fn(() => next()),
    insert: jest.fn(() => next()),
    update: jest.fn(() => next()),
    delete: jest.fn(() => next()),
  };
  return {
    db: calls,
    calls,
    remaining: () => queue.length,
  };
}
