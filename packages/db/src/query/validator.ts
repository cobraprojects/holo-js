import { SecurityError } from '../core/errors'
import type { TableColumnsShape } from '../schema/types'
import type {
  QueryAggregateSelection,
  QueryJoinClause,
  QueryColumnPredicate,
  QueryDatePredicate,
  QueryDirection,
  QueryHavingClause,
  QueryJsonUpdateOperation,
  QueryOperator,
  QueryPlan,
  QueryPredicateNode,
  QueryUpdateValue,
} from './ast'

const IDENTIFIER_PATTERN = /^[A-Z_]\w*$/i
const OPERATORS = new Set<QueryOperator>([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'in',
  'not in',
  'between',
  'not between',
  'like',
])
const DIRECTIONS = new Set<QueryDirection>(['asc', 'desc'])
const DATE_PARTS = new Set<QueryDatePredicate['part']>(['date', 'month', 'day', 'year', 'time'])
const JSON_VALUE_OPERATORS = new Set<QueryOperator>(['=', '!=', '>', '>=', '<', '<=', 'like'])
const JSON_LENGTH_OPERATORS = new Set<QueryOperator>(['=', '!=', '>', '>=', '<', '<='])
const JOIN_OPERATORS = new Set<QueryColumnPredicate['operator']>(['=', '!=', '>', '>=', '<', '<=', 'like'])
const FULLTEXT_MODES = new Set(['natural', 'boolean'])
const HAVING_EXPRESSION_PATTERN = /^(?:[A-Z_]\w*|(?:count|sum|avg|min|max)\((?:\*|[A-Z_]\w*)\))$/i

function assertExplicitBindings(bindings: readonly unknown[], kind: string): void {
  if (bindings.some(value => typeof value === 'undefined')) {
    throw new SecurityError(`${kind} bindings cannot contain undefined values.`)
  }
}

function assertRawSql(sql: string, kind: string): void {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new SecurityError(`${kind} SQL must be a non-empty string.`)
  }
}

function assertRawPlaceholderBindings(sql: string, bindings: readonly unknown[], kind: string): void {
  let anonymousCount = 0
  const questionNumbered = new Set<number>()
  const dollarNumbered = new Set<number>()

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    if (char === '?') {
      let digits = ''
      let cursor = index + 1
      while (cursor < sql.length && /\d/.test(sql[cursor]!)) {
        digits += sql[cursor]!
        cursor += 1
      }

      if (digits.length > 0) {
        questionNumbered.add(Number(digits))
        index = cursor - 1
        continue
      }

      anonymousCount += 1
      continue
    }

    if (char === '$') {
      let digits = ''
      let cursor = index + 1
      while (cursor < sql.length && /\d/.test(sql[cursor]!)) {
        digits += sql[cursor]!
        cursor += 1
      }

      if (digits.length > 0) {
        dollarNumbered.add(Number(digits))
        index = cursor - 1
      }
    }
  }

  const numberedSets = [questionNumbered, dollarNumbered].filter(set => set.size > 0)
  if (anonymousCount > 0 && numberedSets.length > 0) {
    throw new SecurityError(`${kind} SQL cannot mix anonymous and numbered placeholders.`)
  }

  if (questionNumbered.size > 0 && dollarNumbered.size > 0) {
    throw new SecurityError(`${kind} SQL cannot mix question-mark and dollar-numbered placeholders.`)
  }

  if (anonymousCount > 0) {
    if (bindings.length !== anonymousCount) {
      throw new SecurityError(`${kind} SQL placeholder count does not match the provided bindings.`)
    }
    return
  }

  const numbered = questionNumbered.size > 0 ? questionNumbered : dollarNumbered
  if (numbered.size > 0) {
    const highest = Math.max(...numbered)
    if (bindings.length !== highest) {
      throw new SecurityError(`${kind} SQL placeholder count does not match the provided bindings.`)
    }

    for (let placeholder = 1; placeholder <= highest; placeholder += 1) {
      if (!numbered.has(placeholder)) {
        throw new SecurityError(`${kind} SQL must use contiguous numbered placeholders starting at 1.`)
      }
    }
    return
  }

  if (bindings.length > 0) {
    throw new SecurityError(`${kind} SQL cannot provide bindings without placeholders.`)
  }
}

function assertQualifiedIdentifier(value: string, kind: string): void {
  const parts = value.split('.')
  if (parts.length === 0 || parts.some(part => !IDENTIFIER_PATTERN.test(part))) {
    throw new SecurityError(`${kind} "${value}" is not a valid identifier.`)
  }
}

function assertHavingClause(clause: QueryHavingClause): void {
  if (!HAVING_EXPRESSION_PATTERN.test(clause.expression)) {
    throw new SecurityError(`Having expression "${clause.expression}" is not allowed in safe query mode.`)
  }

  if (!OPERATORS.has(clause.operator)) {
    throw new SecurityError(`Operator "${clause.operator}" is not allowed in having clauses.`)
  }

  if (clause.operator === 'between' || clause.operator === 'not between') {
    if (!Array.isArray(clause.value) || clause.value.length !== 2) {
      throw new SecurityError(`${clause.operator.toUpperCase()} having clause for "${clause.expression}" must provide exactly two boundary values.`)
    }

    if (clause.value.some(value => typeof value === 'undefined')) {
      throw new SecurityError(`${clause.operator.toUpperCase()} having clause for "${clause.expression}" cannot contain undefined values.`)
    }
    return
  }

  if (typeof clause.value === 'undefined') {
    throw new SecurityError(`Having value for "${clause.expression}" cannot be undefined.`)
  }
}

function assertAggregateSelection(
  selection: QueryAggregateSelection,
  tableName: string,
  allowedColumns?: Set<string>,
): void {
  if (selection.column !== '*') {
    assertColumnReference(selection.column, tableName, allowedColumns)
  }

  assertIdentifier(selection.alias, 'Selection alias')
}

function assertIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new SecurityError(`${kind} "${value}" is not a valid identifier.`)
  }
}

function createAllowedColumns(plan: QueryPlan): Set<string> | undefined {
  const columns = plan.source.table?.columns
  if (!columns) return undefined
  return new Set(Object.keys(columns))
}

function assertKnownColumn(column: string, tableName: string, allowedColumns?: Set<string>): void {
  assertIdentifier(column, 'Column')

  if (allowedColumns && !allowedColumns.has(column)) {
    throw new SecurityError(`Column "${column}" is not defined on table "${tableName}".`)
  }
}

function assertColumnReference(
  column: string,
  tableName: string,
  allowedColumns?: Set<string>,
): void {
  if (column.includes('.')) {
    assertQualifiedIdentifier(column, 'Column reference')
    return
  }

  assertKnownColumn(column, tableName, allowedColumns)
}

function assertJoinClause(join: QueryJoinClause): void {
  const hasTable = typeof join.table === 'string'
  const hasSubquery = typeof join.subquery !== 'undefined'

  if (hasTable === hasSubquery) {
    throw new SecurityError('Join clauses must target exactly one source: a table or a subquery.')
  }

  if (hasTable) {
    assertQualifiedIdentifier(join.table!, 'Join table')
  } else {
    validateQueryPlan(join.subquery!)
    if (!join.alias) {
      throw new SecurityError('Subquery joins must define an alias.')
    }
    assertIdentifier(join.alias!, 'Join alias')
  }

  if (join.type === 'cross') {
    if (join.leftColumn || join.operator || join.rightColumn) {
      throw new SecurityError('Cross joins cannot include join constraints.')
    }
    return
  }

  if (join.lateral) {
    if (!hasSubquery) {
      throw new SecurityError('Lateral joins require a subquery source.')
    }

    if (join.leftColumn || join.operator || join.rightColumn) {
      throw new SecurityError('Lateral joins cannot include explicit ON column constraints.')
    }
    return
  }

  if (!join.leftColumn || !join.operator || !join.rightColumn) {
    throw new SecurityError(`${join.type.toUpperCase()} joins must include left column, operator, and right column.`)
  }

  assertQualifiedIdentifier(join.leftColumn, 'Join column')
  assertQualifiedIdentifier(join.rightColumn, 'Join column')

  if (!JOIN_OPERATORS.has(join.operator)) {
    throw new SecurityError(`Operator "${join.operator}" is not allowed in join clauses.`)
  }
}

function assertPredicate(
  predicate: QueryPredicateNode,
  tableName: string,
  allowedColumns?: Set<string>,
  sourceColumns?: TableColumnsShape,
): void {
  if (predicate.kind === 'group') {
    if (predicate.predicates.length === 0) {
      throw new SecurityError('Grouped predicates must include at least one nested predicate.')
    }

    for (const nested of predicate.predicates) {
      assertPredicate(nested, tableName, allowedColumns, sourceColumns)
    }

    return
  }

  if (predicate.kind === 'raw') {
    assertRawSql(predicate.sql, 'Raw predicate')
    assertExplicitBindings(predicate.bindings, 'Raw predicate')
    assertRawPlaceholderBindings(predicate.sql, predicate.bindings, 'Raw predicate')
    return
  }

  if (predicate.kind === 'exists') {
    validateQueryPlan(predicate.subquery)
    return
  }

  if (predicate.kind === 'subquery') {
    assertColumnReference(predicate.column, tableName, allowedColumns)

    if (!OPERATORS.has(predicate.operator)) {
      throw new SecurityError(`Operator "${predicate.operator}" is not allowed in subquery predicates.`)
    }

    validateQueryPlan(predicate.subquery)
    return
  }

  if (predicate.kind === 'date') {
    assertColumnReference(predicate.column, tableName, allowedColumns)

    if (!DATE_PARTS.has(predicate.part)) {
      throw new SecurityError(`Date predicate part "${predicate.part}" is not supported.`)
    }

    if (!OPERATORS.has(predicate.operator)) {
      throw new SecurityError(`Operator "${predicate.operator}" is not allowed in safe query mode.`)
    }

    if (typeof predicate.value === 'undefined') {
      throw new SecurityError(`Date predicate value for column "${predicate.column}" cannot be undefined.`)
    }

    return
  }

  if (predicate.kind === 'json') {
    assertColumnReference(predicate.column, tableName, allowedColumns)

    if (predicate.path.some(segment => !segment || typeof segment !== 'string')) {
      throw new SecurityError(`JSON path for column "${predicate.column}" contains an invalid segment.`)
    }

    if (predicate.jsonMode === 'length') {
      if (typeof predicate.operator === 'undefined') {
        throw new SecurityError(`JSON length predicate for column "${predicate.column}" requires an operator.`)
      }

      if (!JSON_LENGTH_OPERATORS.has(predicate.operator)) {
        throw new SecurityError(`Operator "${predicate.operator}" is not allowed for JSON length predicates.`)
      }

      if (typeof predicate.value !== 'number' || Number.isNaN(predicate.value)) {
        throw new SecurityError(`JSON length predicate for column "${predicate.column}" requires a numeric value.`)
      }

      return
    }

    if (predicate.jsonMode === 'value') {
      if (typeof predicate.operator === 'undefined') {
        throw new SecurityError(`JSON value predicate for column "${predicate.column}" requires an operator.`)
      }

      if (!JSON_VALUE_OPERATORS.has(predicate.operator)) {
        throw new SecurityError(`Operator "${predicate.operator}" is not allowed for JSON value predicates.`)
      }

      if (typeof predicate.value === 'undefined') {
        throw new SecurityError(`JSON value predicate for column "${predicate.column}" cannot be undefined.`)
      }

      return
    }

    if (typeof predicate.value === 'undefined') {
      throw new SecurityError(`JSON contains predicate for column "${predicate.column}" cannot be undefined.`)
    }

    return
  }

  if (predicate.kind === 'fulltext') {
    if (predicate.columns.length === 0) {
      throw new SecurityError('Full-text predicates must target at least one column.')
    }

    for (const column of predicate.columns) {
      assertColumnReference(column, tableName, allowedColumns)
    }

    if (!FULLTEXT_MODES.has(predicate.mode)) {
      throw new SecurityError(`Full-text mode "${predicate.mode}" is not supported.`)
    }

    if (!predicate.value.trim()) {
      throw new SecurityError('Full-text predicates require a non-empty search string.')
    }

    return
  }

  if (predicate.kind === 'vector') {
    assertColumnReference(predicate.column, tableName, allowedColumns)

    const baseColumn = predicate.column.includes('.')
      ? predicate.column.split('.').at(-1)!
      : predicate.column
    const columnDefinition = sourceColumns?.[baseColumn]
    if (columnDefinition && columnDefinition.kind !== 'vector') {
      throw new SecurityError(`whereVectorSimilarTo() requires "${predicate.column}" to be a vector column.`)
    }

    if (predicate.vector.length === 0 || predicate.vector.some(value => typeof value !== 'number' || Number.isNaN(value))) {
      throw new SecurityError(`Vector similarity predicates for "${predicate.column}" require a non-empty numeric vector.`)
    }

    if (predicate.minSimilarity < 0 || predicate.minSimilarity > 1) {
      throw new SecurityError('Vector similarity minSimilarity must be between 0 and 1.')
    }

    if (columnDefinition?.vectorDimensions && predicate.vector.length !== columnDefinition.vectorDimensions) {
      throw new SecurityError(`Vector similarity query for "${predicate.column}" must provide ${columnDefinition.vectorDimensions} dimensions.`)
    }

    return
  }

  assertColumnReference(predicate.column, tableName, allowedColumns)

  if (predicate.kind === 'null') {
    return
  }

  if (predicate.kind === 'column') {
    assertColumnReference(predicate.compareTo, tableName, allowedColumns)
    return
  }

  if (!OPERATORS.has(predicate.operator)) {
    throw new SecurityError(`Operator "${predicate.operator}" is not allowed in safe query mode.`)
  }

  if (predicate.operator === 'in' || predicate.operator === 'not in') {
    if (!Array.isArray(predicate.value) || predicate.value.length === 0) {
      throw new SecurityError(`${predicate.operator.toUpperCase()} predicate for column "${predicate.column}" must be a non-empty array.`)
    }

    if (predicate.value.some(value => typeof value === 'undefined')) {
      throw new SecurityError(`${predicate.operator.toUpperCase()} predicate for column "${predicate.column}" cannot contain undefined values.`)
    }

    return
  }

  if (predicate.operator === 'between' || predicate.operator === 'not between') {
    if (!Array.isArray(predicate.value) || predicate.value.length !== 2) {
      throw new SecurityError(`${predicate.operator.toUpperCase()} predicate for column "${predicate.column}" must provide exactly two boundary values.`)
    }

    if (predicate.value.some(value => typeof value === 'undefined')) {
      throw new SecurityError(`${predicate.operator.toUpperCase()} predicate for column "${predicate.column}" cannot contain undefined values.`)
    }

    return
  }

  if (typeof predicate.value === 'undefined') {
    throw new SecurityError(`Predicate value for column "${predicate.column}" cannot be undefined.`)
  }
}

function isJsonUpdateOperation(value: QueryUpdateValue): value is QueryJsonUpdateOperation {
  return typeof value === 'object' && value !== null && 'kind' in value && (value as { kind?: unknown }).kind === 'json-set'
}

function assertJsonUpdateOperation(
  column: string,
  operation: QueryJsonUpdateOperation,
  sourceColumns?: TableColumnsShape,
): void {
  if (operation.path.length === 0 || operation.path.some(segment => !segment || typeof segment !== 'string')) {
    throw new SecurityError(`JSON update for column "${column}" must include a valid nested path.`)
  }

  if (typeof operation.value === 'undefined') {
    throw new SecurityError(`JSON update for column "${column}" cannot use undefined values.`)
  }

  const columnDefinition = sourceColumns?.[column]
  if (columnDefinition && columnDefinition.kind !== 'json') {
    throw new SecurityError(`JSON updates require "${column}" to be a JSON column.`)
  }
}

function assertUpdateValue(
  column: string,
  value: QueryUpdateValue,
  tableName: string,
  allowedColumns?: Set<string>,
  sourceColumns?: TableColumnsShape,
): void {
  assertKnownColumn(column, tableName, allowedColumns)

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new SecurityError(`JSON update for column "${column}" must include at least one operation.`)
    }

    for (const operation of value) {
      if (!isJsonUpdateOperation(operation)) {
        throw new SecurityError(`Update value for column "${column}" is malformed.`)
      }

      assertJsonUpdateOperation(column, operation, sourceColumns)
    }
    return
  }

  if (isJsonUpdateOperation(value)) {
    assertJsonUpdateOperation(column, value, sourceColumns)
    return
  }

  if (typeof value === 'undefined') {
    throw new SecurityError(`Update value for column "${column}" cannot be undefined.`)
  }
}

function assertNonNegativeInteger(value: number | undefined, kind: string): void {
  if (typeof value === 'undefined') return

  if (!Number.isInteger(value) || value < 0) {
    throw new SecurityError(`${kind} must be a non-negative integer.`)
  }
}

export function validateQueryPlan(plan: QueryPlan): void {
  assertQualifiedIdentifier(plan.source.tableName, 'Table')
  if (plan.source.alias) {
    assertIdentifier(plan.source.alias, 'Table alias')
  }
  const allowedColumns = createAllowedColumns(plan)

  switch (plan.kind) {
    case 'select': {
      for (const selection of plan.selections) {
        if (selection.kind === 'subquery') {
          validateQueryPlan(selection.query)
          assertIdentifier(selection.alias, 'Selection alias')
          continue
        }

        if (selection.kind === 'aggregate') {
          assertAggregateSelection(selection, plan.source.tableName, allowedColumns)
          continue
        }

        if (selection.kind === 'raw') {
          assertRawSql(selection.sql, 'Raw selection')
          assertExplicitBindings(selection.bindings, 'Raw selection')
          assertRawPlaceholderBindings(selection.sql, selection.bindings, 'Raw selection')
          continue
        }

        assertColumnReference(selection.column, plan.source.tableName, allowedColumns)
        if (selection.alias) {
          assertIdentifier(selection.alias, 'Selection alias')
        }
      }

      for (const join of plan.joins) {
        assertJoinClause(join)
      }

      for (const union of plan.unions) {
        validateQueryPlan(union.query)
      }

      for (const predicate of plan.predicates) {
        assertPredicate(predicate, plan.source.tableName, allowedColumns, plan.source.table?.columns)
      }

      for (const column of plan.groupBy) {
        assertColumnReference(column, plan.source.tableName, allowedColumns)
      }

      for (const clause of plan.having) {
        assertHavingClause(clause)
      }

      for (const orderBy of plan.orderBy) {
        if (orderBy.kind === 'random') {
          continue
        }

        if (orderBy.kind === 'raw') {
          assertRawSql(orderBy.sql, 'Raw ORDER BY')
          assertExplicitBindings(orderBy.bindings, 'Raw ORDER BY')
          assertRawPlaceholderBindings(orderBy.sql, orderBy.bindings, 'Raw ORDER BY')
          continue
        }

        if (orderBy.kind === 'vector') {
          assertColumnReference(orderBy.column, plan.source.tableName, allowedColumns)
          const baseColumn = orderBy.column.includes('.')
            ? orderBy.column.split('.').at(-1)!
            : orderBy.column
          const columnDefinition = plan.source.table?.columns[baseColumn]
          if (columnDefinition && columnDefinition.kind !== 'vector') {
            throw new SecurityError(`Vector ordering requires "${orderBy.column}" to be a vector column.`)
          }

          if (orderBy.vector.length === 0 || orderBy.vector.some(value => typeof value !== 'number' || Number.isNaN(value))) {
            throw new SecurityError(`Vector ordering for "${orderBy.column}" requires a non-empty numeric vector.`)
          }

          if (columnDefinition?.vectorDimensions && orderBy.vector.length !== columnDefinition.vectorDimensions) {
            throw new SecurityError(`Vector ordering for "${orderBy.column}" must provide ${columnDefinition.vectorDimensions} dimensions.`)
          }
          continue
        }

        assertColumnReference(orderBy.column, plan.source.tableName, allowedColumns)

        if (!DIRECTIONS.has(orderBy.direction)) {
          throw new SecurityError(`Order direction "${orderBy.direction}" is not allowed.`)
        }
      }

      assertNonNegativeInteger(plan.limit, 'Limit')
      assertNonNegativeInteger(plan.offset, 'Offset')
      return
    }

    case 'insert': {
      if (plan.values.length === 0) {
        throw new SecurityError('Insert queries must include at least one row.')
      }

      const expectedColumns = Object.keys(plan.values[0]!)
      if (expectedColumns.length === 0) {
        throw new SecurityError('Insert queries must include at least one column.')
      }

      for (const column of expectedColumns) {
        assertKnownColumn(column, plan.source.tableName, allowedColumns)
      }

      for (const valueSet of plan.values) {
        const keys = Object.keys(valueSet)
        if (keys.length !== expectedColumns.length || !expectedColumns.every(column => keys.includes(column))) {
          throw new SecurityError('Every inserted row must provide the same set of columns.')
        }

        for (const column of keys) {
          if (typeof valueSet[column] === 'undefined') {
            throw new SecurityError(`Insert value for column "${column}" cannot be undefined.`)
          }
        }
      }
      return
    }

    case 'upsert': {
      if (plan.values.length === 0) {
        throw new SecurityError('Upsert queries must include at least one row.')
      }

      if (plan.uniqueBy.length === 0) {
        throw new SecurityError('Upsert queries must define at least one unique conflict column.')
      }

      const expectedColumns = Object.keys(plan.values[0]!)
      if (expectedColumns.length === 0) {
        throw new SecurityError('Upsert queries must include at least one column.')
      }

      for (const column of expectedColumns) {
        assertKnownColumn(column, plan.source.tableName, allowedColumns)
      }

      for (const column of plan.uniqueBy) {
        assertKnownColumn(column, plan.source.tableName, allowedColumns)
        if (!expectedColumns.includes(column)) {
          throw new SecurityError(`Upsert unique column "${column}" must be present in every row.`)
        }
      }

      for (const column of plan.updateColumns) {
        assertKnownColumn(column, plan.source.tableName, allowedColumns)
        if (!expectedColumns.includes(column)) {
          throw new SecurityError(`Upsert update column "${column}" must be present in every row.`)
        }
      }

      for (const valueSet of plan.values) {
        const keys = Object.keys(valueSet)
        if (keys.length !== expectedColumns.length || !expectedColumns.every(column => keys.includes(column))) {
          throw new SecurityError('Every upsert row must provide the same set of columns.')
        }

        for (const column of keys) {
          if (typeof valueSet[column] === 'undefined') {
            throw new SecurityError(`Upsert value for column "${column}" cannot be undefined.`)
          }
        }
      }

      return
    }

    case 'update': {
      const keys = Object.keys(plan.values)
      if (keys.length === 0) {
        throw new SecurityError('Update queries must include at least one column.')
      }

      for (const column of keys) {
        assertUpdateValue(column, plan.values[column]!, plan.source.tableName, allowedColumns, plan.source.table?.columns)
      }

      for (const predicate of plan.predicates) {
        assertPredicate(predicate, plan.source.tableName, allowedColumns)
      }
      return
    }

    case 'delete': {
      for (const predicate of plan.predicates) {
        assertPredicate(predicate, plan.source.tableName, allowedColumns)
      }
    }
  }
}
