import { queryCacheInternals } from '@holo-js/db'
import { EMPTY_RESULT_PATH, getValueAtPath, type RealtimePatchPathSegment } from './result-patching'
import type { DatabaseQueryObservation } from './query-state'
import { createPatchedQueryObservation, readPatchPathKey } from './query-patch-targets'
import { isRecord, isRecordArray } from './value'

function belongsToOwnerPath(
  query: DatabaseQueryObservation,
  owner: DatabaseQueryObservation,
): boolean {
  const base = owner.resultPath ?? EMPTY_RESULT_PATH
  const path = query.resultPath ?? EMPTY_RESULT_PATH
  if (!base.every((segment, index) => path[index] === segment)) return false
  const suffix = path.slice(base.length)
  const relationKey = query.relation?.kind === 'belongsToParentKey'
    ? query.relation.relationKey
    : suffix.at(-1)
  if (!owner.belongsToHydrations?.some(hydration => hydration.relationKey === relationKey)) return false
  return query.relation?.kind === 'belongsToParentKey'
    ? suffix.length === 1 && typeof suffix[0] === 'number'
    : suffix.length === 2 && typeof suffix[0] === 'number'
}

export function rebindBelongsToObservations(
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): readonly DatabaseQueryObservation[] {
  const owners = queries.filter(query => {
    const rows = getValueAtPath(data, query.resultPath ?? EMPTY_RESULT_PATH)
    return query.belongsToHydrations?.length && isRecordArray(rows)
      && rows.every(row => query.belongsToHydrations?.every(hydration => Object.hasOwn(row, hydration.foreignKey) && Object.hasOwn(row, hydration.relationKey)))
  })
  if (owners.length === 0) return queries
  const next = queries.filter(query => !owners.some(owner => belongsToOwnerPath(query, owner))).map(query => owners.includes(query)
    ? createPatchedQueryObservation(query, getValueAtPath(data, query.resultPath ?? EMPTY_RESULT_PATH), readPatchPathKey(query))
    : query)
  for (const owner of owners) {
    const base = owner.resultPath ?? EMPTY_RESULT_PATH
    const rows = getValueAtPath(data, base)
    if (!isRecordArray(rows)) continue
    for (const [index, row] of rows.entries()) {
      for (const hydration of owner.belongsToHydrations ?? []) {
        const foreignKey = row[hydration.foreignKey]
        if (foreignKey === null || typeof foreignKey === 'undefined') continue
        const dependency = queryCacheInternals.createTablePredicateCacheDependency(hydration.relatedConnectionName, hydration.relatedTableName, hydration.ownerKey, foreignKey)
        if (!dependency) continue
        const related = row[hydration.relationKey]
        if (related !== null && !isRecord(related)) continue
        const resultPath: readonly RealtimePatchPathSegment[] = Object.freeze([...base, index, hydration.relationKey])
        next.push(Object.freeze({
          connectionName: hydration.relatedConnectionName,
          dependencies: Object.freeze([queryCacheInternals.createTableCacheDependency(hydration.relatedConnectionName, hydration.relatedTableName), dependency]),
          emptyRecordValue: null,
          limit: 1,
          orderBy: [],
          patchable: true,
          predicates: Object.freeze([{ column: hydration.ownerKey, operator: '=' as const, value: foreignKey }]),
          result: related,
          resultBound: true,
          resultPath,
          rowWindowMode: 'single' as const,
          selections: [],
          tableName: hydration.relatedTableName,
        }))
      }
    }
  }
  return next
}
