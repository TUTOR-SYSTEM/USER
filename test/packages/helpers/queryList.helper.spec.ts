import { buildListWhereClause } from 'src/packages/helpers/queryList.helper';

const contains = (term: string) => ({ contains: term, mode: 'insensitive' });

describe('buildListWhereClause', () => {
  it('returns undefined when there is no search and no filters', () => {
    expect(buildListWhereClause({})).toBeUndefined();
  });

  it('ignores a blank or whitespace-only search', () => {
    expect(
      buildListWhereClause({
        search: '   ',
        searchableColumns: { name: { column: 'name' } },
      }),
    ).toBeUndefined();
  });

  it('ORs a case-insensitive contains across every searchable column and trims the term', () => {
    expect(
      buildListWhereClause({
        search: '  foo ',
        searchableColumns: { name: { column: 'name' }, code: { column: 'code' } },
      }),
    ).toEqual({ OR: [{ name: contains('foo') }, { code: contains('foo') }] });
  });

  it('uses a single-entry OR when only one column is searchable', () => {
    expect(
      buildListWhereClause({ search: 'bar', searchableColumns: { name: { column: 'name' } } }),
    ).toEqual({ OR: [{ name: contains('bar') }] });
  });

  it('adds no search condition when no searchable columns are configured', () => {
    expect(buildListWhereClause({ search: 'bar' })).toBeUndefined();
  });

  it('adds exact-match conditions for configured filters with a value', () => {
    expect(
      buildListWhereClause({
        filters: { status: 'OPEN' },
        filterColumns: { status: { column: 'status' } },
      }),
    ).toEqual({ status: 'OPEN' });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('skips a filter whose value is %s', (_label, value) => {
    expect(
      buildListWhereClause({
        filters: { status: value },
        filterColumns: { status: { column: 'status' } },
      }),
    ).toBeUndefined();
  });

  it('keeps falsy but defined values such as 0, false and empty string', () => {
    expect(
      buildListWhereClause({
        filters: { qty: 0, active: false, code: '' },
        filterColumns: {
          qty: { column: 'qty' },
          active: { column: 'active' },
          code: { column: 'code' },
        },
      }),
    ).toEqual({ AND: [{ qty: 0 }, { active: false }, { code: '' }] });
  });

  it('ignores filter keys that have no column mapping', () => {
    expect(
      buildListWhereClause({
        filters: { unknownField: 'x' },
        filterColumns: { status: { column: 'status' } },
      }),
    ).toBeUndefined();
  });

  it('applies the column transform to the filter value', () => {
    expect(
      buildListWhereClause({
        filters: { qty: '7' as unknown as number },
        filterColumns: {
          qty: { column: 'qty', transform: (v) => Number(v) * 10 },
        },
      }),
    ).toEqual({ qty: 70 });
  });

  it('maps a filter key onto its configured column name', () => {
    expect(
      buildListWhereClause({
        filters: { owner: 'u1' },
        filterColumns: { owner: { column: 'tutorId' } },
      }),
    ).toEqual({ tutorId: 'u1' });
  });

  it('combines search and multiple filters with AND', () => {
    expect(
      buildListWhereClause({
        search: 'x',
        searchableColumns: { name: { column: 'name' } },
        filters: { status: 'OPEN', qty: 2 },
        filterColumns: { status: { column: 'status' }, qty: { column: 'qty' } },
      }),
    ).toEqual({ AND: [{ OR: [{ name: contains('x') }] }, { status: 'OPEN' }, { qty: 2 }] });
  });

  it('skips searchable entries that are empty and keeps the rest', () => {
    const where = buildListWhereClause({
      search: 'ann',
      searchableColumns: { name: { column: 'name' }, code: undefined } as never,
    });
    expect(where).toEqual({ OR: [{ name: contains('ann') }] });
  });
});
