type SearchableColumn = {
  /** Prisma model field name to match with a case-insensitive `contains`. */
  column: string;
};

type FilterableColumn<TValue> = {
  /** Prisma model field name to match exactly. */
  column: string;
  transform?: (value: TValue) => TFilterComparable;
};

type TFilterComparable = string | number | boolean | Date;

export type BuildListWhereClauseParams<
  TSearchField extends string,
  TFilterField extends string,
  TFilterValue,
> = {
  search?: string;
  searchableColumns?: Partial<Record<TSearchField, SearchableColumn>>;
  filters?: Partial<Record<TFilterField, TFilterValue | null | undefined>>;
  filterColumns?: Partial<Record<TFilterField, FilterableColumn<TFilterValue>>>;
};

/**
 * Build a Prisma `where` object for list APIs:
 * - `search`: OR across configured searchable fields (`contains`, case-insensitive)
 * - `filters`: AND exact-match conditions, skipping undefined/null
 *
 * Returns `undefined` when there is nothing to filter on. `TWhere` is the model's
 * `Prisma.<Model>WhereInput`, which the generic result is shaped as.
 */
export function buildListWhereClause<
  TWhere extends object,
  TSearchField extends string = string,
  TFilterField extends string = string,
  TFilterValue = unknown,
>({
  search,
  searchableColumns,
  filters,
  filterColumns,
}: BuildListWhereClauseParams<TSearchField, TFilterField, TFilterValue>): TWhere | undefined {
  const conditions: Record<string, unknown>[] = [];

  if (search?.trim()) {
    const term = search.trim();
    const searchConditions = (Object.values(searchableColumns ?? {}) as SearchableColumn[])
      .filter((item) => !!item)
      .map((item) => ({ [item.column]: { contains: term, mode: 'insensitive' } }));

    if (searchConditions.length > 0) {
      conditions.push({ OR: searchConditions });
    }
  }

  for (const [field, value] of Object.entries(filters ?? {})) {
    if (value === undefined || value === null) continue;

    const item = filterColumns?.[field as TFilterField];
    if (item) {
      const normalizedValue = item.transform
        ? item.transform(value as TFilterValue)
        : (value as TFilterValue);
      conditions.push({ [item.column]: normalizedValue });
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0] as TWhere;

  return { AND: conditions } as TWhere;
}
