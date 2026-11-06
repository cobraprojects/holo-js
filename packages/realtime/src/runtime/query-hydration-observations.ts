import { queryCacheInternals } from '@holo-js/db'
import { EMPTY_RESULT_PATH, getValueAtPath, type RealtimePatchPathSegment } from './result-patching'
import type { DatabaseQueryBelongsToManyRelationObservation, DatabaseQueryObservation, DatabaseQueryRelatedHydrationObservation } from './query-state'
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
        const tableDependency = queryCacheInternals.createTableCacheDependency(hydration.relatedConnectionName, hydration.relatedTableName)
        const related = row[hydration.relationKey]
        if (related !== null && !isRecord(related)) continue
        const resultPath: readonly RealtimePatchPathSegment[] = Object.freeze([...base, index, hydration.relationKey])
        next.push(Object.freeze({
          connectionName: hydration.relatedConnectionName,
          dependencies: Object.freeze(dependency ? [tableDependency, dependency] : [tableDependency]),
          emptyRecordValue: null,
          limit: 1,
          orderBy: [],
          patchable: hydration.primaryKey !== undefined,
          predicates: Object.freeze([{ column: hydration.ownerKey, operator: '=' as const, value: foreignKey }, ...hydration.predicates]),
          primaryKey: hydration.primaryKey,
          result: related,
          resultBound: true,
          resultPath,
          rowWindowMode: 'single' as const,
          selections: [],
          table: hydration.relatedTable,
          tableName: hydration.relatedTableName,
        }))
      }
    }
  }
  return next
}

function isRelatedHydrationChild(
  query: DatabaseQueryObservation,
  owner: DatabaseQueryObservation,
): boolean {
  const base = owner.resultPath ?? EMPTY_RESULT_PATH
  const path = query.resultPath ?? EMPTY_RESULT_PATH
  if (query === owner || query.relation || path.length !== base.length + 2) return false
  if (!base.every((segment, index) => path[index] === segment) || typeof path[base.length] !== 'number') return false
  return owner.relatedHydrations?.some(hydration => hydration.relationKey === path[base.length + 1]) === true
}

function foreignKeyPredicateIndex(query: DatabaseQueryObservation, hydration: DatabaseQueryRelatedHydrationObservation): number {
  return query.predicates.findIndex(predicate => predicate.column === hydration.foreignKey && predicate.operator === '=')
}

function foreignKeyDependency(hydration: DatabaseQueryRelatedHydrationObservation, value: unknown, textMatchesAnyNumber: boolean): string | undefined {
  return queryCacheInternals.createTablePredicateCacheDependency(hydration.relatedConnectionName, hydration.relatedTableName, hydration.foreignKey, value, textMatchesAnyNumber)
}

function createRelatedHydrationObservation(
  hydration: DatabaseQueryRelatedHydrationObservation,
  template: DatabaseQueryObservation | undefined,
  localKey: unknown,
  related: unknown,
  resultPath: readonly RealtimePatchPathSegment[],
): DatabaseQueryObservation {
  const dependency = foreignKeyDependency(hydration, localKey, true)
  const tableDependency = queryCacheInternals.createTableCacheDependency(hydration.relatedConnectionName, hydration.relatedTableName)
  const predicateIndex = template ? foreignKeyPredicateIndex(template, hydration) : -1
  if (!template || predicateIndex < 0) {
    return Object.freeze({
      connectionName: hydration.relatedConnectionName,
      dependencies: Object.freeze(dependency ? [tableDependency, dependency] : [tableDependency]),
      orderBy: hydration.orderBy,
      patchable: false,
      predicates: Object.freeze([...hydration.predicates, Object.freeze({ column: hydration.foreignKey, operator: '=' as const, value: localKey })]),
      primaryKey: hydration.primaryKey,
      result: related,
      resultBound: true,
      resultPath,
      selections: [],
      table: hydration.relatedTable,
      tableName: hydration.relatedTableName,
    })
  }
  const templateValue = template.predicates[predicateIndex]!.value
  const staleDependencies = new Set([foreignKeyDependency(hydration, templateValue, true), foreignKeyDependency(hydration, templateValue, false)])
  const observation: DatabaseQueryObservation = {
    ...template,
    dependencies: Object.freeze([...new Set([...template.dependencies.filter(entry => !staleDependencies.has(entry)), ...dependency ? [dependency] : []])]),
    exactId: undefined,
    patchPlan: undefined,
    predicates: Object.freeze(template.predicates.map((predicate, index) => index === predicateIndex ? Object.freeze({ ...predicate, value: localKey }) : predicate)),
    result: related,
    resultPath,
    resultPathKey: undefined,
    rowBackfillKeyPrefix: undefined,
    rowIdentityIndex: undefined,
  }
  return createPatchedQueryObservation(observation, related, readPatchPathKey(observation))
}

function relatedHydrationTemplateKey(base: readonly unknown[], relationKey: unknown): string {
  return JSON.stringify([base, relationKey])
}

export function rebindRelatedHydrationObservations(
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): readonly DatabaseQueryObservation[] {
  const owners = queries.filter(query => {
    const rows = getValueAtPath(data, query.resultPath ?? EMPTY_RESULT_PATH)
    return query.relatedHydrations?.length && isRecordArray(rows)
      && rows.every(row => query.relatedHydrations?.every(hydration => Object.hasOwn(row, hydration.localKey) && Object.hasOwn(row, hydration.relationKey)))
  })
  if (owners.length === 0) return queries
  const children = new Map<string, DatabaseQueryObservation>()
  const templates = new Map<string, DatabaseQueryObservation>()
  const next = queries.filter((query) => {
    const owner = owners.find(candidate => isRelatedHydrationChild(query, candidate))
    if (!owner) return true
    const path = query.resultPath ?? EMPTY_RESULT_PATH
    const hydration = owner.relatedHydrations?.find(candidate => candidate.relationKey === path.at(-1))
    const templateKey = relatedHydrationTemplateKey(path.slice(0, -2), path.at(-1))
    if (hydration && !templates.has(templateKey) && foreignKeyPredicateIndex(query, hydration) >= 0) templates.set(templateKey, query)
    children.set(JSON.stringify(path), query)
    return false
  })
  let changed = false
  for (const owner of owners) {
    const base = owner.resultPath ?? EMPTY_RESULT_PATH
    const rows = getValueAtPath(data, base)
    if (!isRecordArray(rows)) continue
    for (const [index, row] of rows.entries()) {
      for (const hydration of owner.relatedHydrations ?? []) {
        const localKey = row[hydration.localKey]
        const related = row[hydration.relationKey]
        if (localKey === null || typeof localKey === 'undefined') continue
        if (hydration.kind === 'hasMany' ? !isRecordArray(related) : related !== null && !isRecord(related)) continue
        const resultPath = Object.freeze([...base, index, hydration.relationKey])
        const existing = children.get(JSON.stringify(resultPath))
        if (existing && reusesRelatedHydrationChild(existing, hydration, localKey, related)) {
          next.push(existing)
          continue
        }
        changed = true
        const template = existing && foreignKeyPredicateIndex(existing, hydration) >= 0
          ? existing
          : templates.get(relatedHydrationTemplateKey(base, hydration.relationKey))
        next.push(createRelatedHydrationObservation(hydration, template, localKey, related, resultPath))
      }
    }
  }
  return changed || next.length !== queries.length ? next : queries
}

function reusesRelatedHydrationChild(
  query: DatabaseQueryObservation,
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
  related: unknown,
): boolean {
  return query.resultBound === true
    && query.result === related
    && query.predicates.some(predicate => predicate.column === hydration.foreignKey && predicate.operator === '=' && Object.is(predicate.value, localKey))
}

function isBelongsToManyRelatedSide(query: DatabaseQueryObservation): boolean {
  return query.relation?.kind === 'belongsToMany'
    && query.connectionName === query.relation.relatedConnectionName
    && query.tableName === query.relation.relatedTableName
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function createBelongsToManyRelatedSideObservation(
  pivotSide: DatabaseQueryObservation,
  relation: DatabaseQueryBelongsToManyRelationObservation,
  values: readonly unknown[],
  existing: DatabaseQueryObservation | undefined,
): DatabaseQueryObservation {
  const source = existing ?? pivotSide
  const dependencies = values.flatMap(value => queryCacheInternals.createTablePredicateCacheDependency(relation.relatedConnectionName, relation.relatedTableName, relation.relatedKey, value, true) ?? [])
  return Object.freeze({
    connectionName: relation.relatedConnectionName,
    dependencies: Object.freeze([...new Set([queryCacheInternals.createTableCacheDependency(relation.relatedConnectionName, relation.relatedTableName), ...dependencies])]),
    orderBy: [],
    patchable: source.patchable,
    ...source.serialized ? { serialized: true } : {},
    predicates: Object.freeze([Object.freeze({ column: relation.relatedKey, operator: 'in' as const, value: Object.freeze([...values]) })]),
    relation,
    resultPath: pivotSide.resultPath,
    selections: [],
    table: relation.relatedTable,
    tableName: relation.relatedTableName,
  })
}

export function rebindBelongsToManyRelatedObservations(
  queries: readonly DatabaseQueryObservation[],
  data: unknown,
): readonly DatabaseQueryObservation[] {
  const relatedSides = new Map<string, DatabaseQueryObservation>()
  for (const query of queries) {
    if (isBelongsToManyRelatedSide(query)) relatedSides.set(readPatchPathKey(query), query)
  }
  const replacements = new Map<DatabaseQueryObservation, DatabaseQueryObservation | undefined>()
  const added: DatabaseQueryObservation[] = []
  for (const pivotSide of queries) {
    const relation = pivotSide.relation
    if (relation?.kind !== 'belongsToMany' || isBelongsToManyRelatedSide(pivotSide)) continue
    const rows = getValueAtPath(data, pivotSide.resultPath ?? EMPTY_RESULT_PATH)
    if (!isRecordArray(rows) || !rows.every(row => Object.hasOwn(row, relation.relatedKey))) continue
    const values = rows.map(row => row[relation.relatedKey])
    const existing = relatedSides.get(readPatchPathKey(pivotSide))
    const existingValues = existing?.predicates[0]?.value
    if (existing ? Array.isArray(existingValues) && sameValues(existingValues, values) : values.length === 0) continue
    const observation = values.length === 0 ? undefined : createBelongsToManyRelatedSideObservation(pivotSide, relation, values, existing)
    if (existing) replacements.set(existing, observation)
    else if (observation) added.push(observation)
  }
  if (replacements.size === 0 && added.length === 0) return queries
  return [
    ...queries.flatMap(query => replacements.has(query) ? replacements.get(query) ?? [] : [query]),
    ...added,
  ]
}
