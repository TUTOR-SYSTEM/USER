/** Every Prisma delegate method the repositories use, as a bare `jest.fn()`. */
const DELEGATE_METHODS = [
  'findUnique',
  'findFirst',
  'findMany',
  'create',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
] as const;

type Delegate = Record<(typeof DELEGATE_METHODS)[number], jest.Mock>;

function makeDelegate(): Delegate {
  return Object.fromEntries(DELEGATE_METHODS.map((m) => [m, jest.fn()])) as Delegate;
}

/** Stand-in for `PrismaService`: one mocked delegate per model the repositories touch. */
export function makePrismaMock() {
  return { user: makeDelegate(), grade: makeDelegate() };
}
