import { getTableConfig } from 'drizzle-orm/pg-core';
import { users } from 'src/database/schema';

describe('users self-references', () => {
  it('resolve parentId and tutorId to users.id (lazy FK thunks)', () => {
    const { foreignKeys } = getTableConfig(users);
    const targets = foreignKeys.map((fk) => {
      const { columns, foreignColumns } = fk.reference();
      return {
        column: columns[0].name,
        target: foreignColumns[0].name,
      };
    });

    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'parent_id', target: 'id' }),
        expect.objectContaining({ column: 'tutor_id', target: 'id' }),
      ]),
    );
  });
});
