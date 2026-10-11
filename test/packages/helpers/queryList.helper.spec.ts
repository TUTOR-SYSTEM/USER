import { integer, pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildListWhereClause } from 'src/packages/helpers/queryList.helper';

const items = pgTable('items', {
  name: text('name'),
  code: text('code'),
  status: text('status'),
  qty: integer('qty'),
  active: boolean('active'),
});

const dialect = new PgDialect();
const render = (where: ReturnType<typeof buildListWhereClause>) =>
  where ? dialect.sqlToQuery(where) : undefined;

describe('buildListWhereClause', () => {
  it('returns undefined when there is no search and no filters', () => {
    expect(buildListWhereClause({})).toBeUndefined();
  });

  it('ignores a blank or whitespace-only search', () => {
    expect(
      buildListWhereClause({
        search: '   ',
        searchableColumns: { name: { column: items.name } },
      }),
    ).toBeUndefined();
  });

  it('ORs ILIKE across every searchable column and trims the term', () => {
    const q = render(
      buildListWhereClause({
        search: '  foo ',
        searchableColumns: { name: { column: items.name }, code: { column: items.code } },
      }),
    );
    expect(q?.sql).toMatch(/"items"\."name" ilike .+ or "items"\."code" ilike /);
    expect(q?.params).toEqual(['%foo%', '%foo%']);
  });

  it('uses a single ILIKE without OR when only one column is searchable', () => {
    const q = render(
      buildListWhereClause({ search: 'bar', searchableColumns: { name: { column: items.name } } }),
    );
    expect(q?.sql).not.toMatch(/\bor\b/i);
    expect(q?.params).toEqual(['%bar%']);
  });

  it('adds no search condition when no searchable columns are configured', () => {
    expect(buildListWhereClause({ search: 'bar' })).toBeUndefined();
  });

  it('adds EQ conditions for configured filters with a value', () => {
    const q = render(
      buildListWhereClause({
        filters: { status: 'OPEN' },
        filterColumns: { status: { column: items.status } },
      }),
    );
    expect(q?.sql).toMatch(/"items"\."status" = /);
    expect(q?.params).toEqual(['OPEN']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('skips a filter whose value is %s', (_label, value) => {
    expect(
      buildListWhereClause({
        filters: { status: value },
        filterColumns: { status: { column: items.status } },
      }),
    ).toBeUndefined();
  });

  it('keeps falsy but defined values such as 0, false and empty string', () => {
    const q = render(
      buildListWhereClause({
        filters: { qty: 0, active: false, code: '' },
        filterColumns: {
          qty: { column: items.qty },
          active: { column: items.active },
          code: { column: items.code },
        },
      }),
    );
    expect(q?.params).toEqual(expect.arrayContaining([0, false, '']));
    expect(q?.params).toHaveLength(3);
  });

  it('ignores filter keys that have no column mapping', () => {
    expect(
      buildListWhereClause({
        filters: { unknownField: 'x' },
        filterColumns: { status: { column: items.status } },
      }),
    ).toBeUndefined();
  });

  it('applies the column transform to the filter value', () => {
    const q = render(
      buildListWhereClause({
        filters: { qty: '7' as unknown as number },
        filterColumns: {
          qty: { column: items.qty, transform: (v) => Number(v) * 10 },
        },
      }),
    );
    expect(q?.params).toEqual([70]);
  });

  it('combines search and multiple filters with AND', () => {
    const q = render(
      buildListWhereClause({
        search: 'x',
        searchableColumns: { name: { column: items.name } },
        filters: { status: 'OPEN', qty: 2 },
        filterColumns: { status: { column: items.status }, qty: { column: items.qty } },
      }),
    );
    expect(q?.sql).toMatch(/ and /i);
    expect(q?.params).toEqual(['%x%', 'OPEN', 2]);
  });
  it('skips searchable entries that are empty and keeps the rest', () => {
    const where = buildListWhereClause({
      search: 'ann',
      searchableColumns: { name: { column: items.name }, code: undefined } as never,
    });
    expect(render(where)?.sql).toMatch(/"items"\."name" ilike /);
    expect(render(where)?.sql).not.toMatch(/"items"\."code"/);
  });
});
