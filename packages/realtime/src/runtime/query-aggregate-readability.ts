import type { TableQueryBuilder } from '@holo-js/db'
import type { DatabaseQueryObservation } from './query-state'

type AggregateReadColumn = { readonly column: string, readonly integer: boolean }

export function aggregateReadColumns(query: DatabaseQueryObservation): readonly AggregateReadColumn[] {
  const selections = query.selections ?? []
  return Object.entries(query.table?.columns ?? {}).flatMap(([column, definition]) => {
    if (selections.length > 0 && !selections.some(selection => selection.column === '*' || selection.column === column)) return []
    const integer = definition.kind === 'integer' || definition.kind === 'bigInteger' || (definition.kind === 'id' && definition.idStrategy === 'autoIncrement')
    const date = definition.kind === 'date' || definition.kind === 'datetime' || definition.kind === 'timestamp'
    return integer || date ? [{ column, integer }] : []
  })
}

export function addAggregateReadChecks(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  columns: readonly AggregateReadColumn[],
): TableQueryBuilder<string, Record<string, unknown>> {
  for (const [index, { column }] of columns.entries()) {
    builder = builder.addSelectMin(`__holo_read_min_${index}`, column).addSelectMax(`__holo_read_max_${index}`, column)
  }
  return builder
}

export function hasReadableAggregateValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly AggregateReadColumn[],
  aggregated = false,
): boolean {
  return rows.every(row => columns.every(({ column, integer }, index) => {
    const values = aggregated ? [row[`__holo_read_min_${index}`], row[`__holo_read_max_${index}`]] : [row[column]]
    return values.every(value => value == null || (integer
      ? Number.isSafeInteger(Number(value))
      : Number.isFinite(value instanceof Date ? value.getTime() : Date.parse(String(value)))))
  }))
}
