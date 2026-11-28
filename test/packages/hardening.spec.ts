import { of } from 'rxjs';
import { buildListWhereClause, MAX_SEARCH_TOKENS } from 'src/packages/helpers/queryList.helper';
import { getUsersQuerySchema, updateUserSchema } from 'src/packages/entities/user/user.schema';
import { listManagedUsersQuerySchema } from 'src/packages/entities/admin/admin.schema';
import {
  getStudentsQuerySchema,
  updateStudentSchema,
} from 'src/packages/entities/student/student.schema';
import { AppController } from 'src/app.controller';

describe('list search limits', () => {
  it('uses at most MAX_SEARCH_TOKENS words of a search string', () => {
    const where = buildListWhereClause<{ AND: unknown[] }>({
      search: 'a b c d e f g h',
      searchableColumns: { name: { column: 'name' } },
    });
    expect(where?.AND).toHaveLength(MAX_SEARCH_TOKENS);
  });

  it.each([
    ['users', getUsersQuerySchema],
    ['admin lists', listManagedUsersQuerySchema],
    ['students', getStudentsQuerySchema],
  ])('rejects a search string over 100 characters (%s)', (_name, schema) => {
    expect(schema.safeParse({ search: 'x'.repeat(101) }).success).toBe(false);
    expect(schema.safeParse({ search: 'x'.repeat(100) }).success).toBe(true);
  });
});

describe('avatar URLs', () => {
  it.each([
    ['user update', (v: string) => updateUserSchema.safeParse({ avatar: v })],
    ['student update', (v: string) => updateStudentSchema.safeParse({ avatar: v })],
  ])('%s accepts https images only', (_name, parse) => {
    expect(parse('https://cdn.example.com/a.png').success).toBe(true);
    expect(parse('javascript:alert(1)//x.png').success).toBe(false);
    expect(parse('data:image/png;base64,AAAA//x.png').success).toBe(false);
  });
});

describe('health.postgres', () => {
  it('reports counts without loading user rows or returning personal data', async () => {
    const db = {
      user: {
        findMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([
          { role: 'ADMIN', _count: { _all: 1 } },
          { role: 'STUDENT', _count: { _all: 4 } },
        ]),
      },
    };
    const controller = new AppController({} as never, {} as never, db as never);
    const result = (await controller.checkPostgresHealth()) as Record<string, unknown>;

    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'healthy',
      stats: { totalUsers: 5, byRole: { admin: 1, tutor: 0, student: 4, parent: 0 } },
    });
    expect(JSON.stringify(result)).not.toContain('sampleUsers');
  });
});
