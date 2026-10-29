import type { TableQueryBuilder } from './TableQueryBuilder'

type TableQueryPlanReader = Pick<TableQueryBuilder, 'getPlan'>

export function getQueryBounds(
  query: TableQueryPlanReader | { getTableQueryBuilder(): TableQueryPlanReader },
): Readonly<{ limit: number | undefined, offset: number | undefined }> {
  const plan = ('getTableQueryBuilder' in query ? query.getTableQueryBuilder() : query).getPlan()
  return Object.freeze({ limit: plan.limit, offset: plan.offset })
}
