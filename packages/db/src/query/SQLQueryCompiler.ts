import { CompilerError } from '../core/errors'
import { validateQueryPlan } from './validator'
import type { CompiledStatement, CompiledStatementMetadata } from '../core/types'
import type {
  DeleteQueryPlan,
  QueryDatePredicate,
  QueryFullTextPredicate,
  QueryHavingClause,
  QueryJsonUpdateOperation,
  QueryJoinClause,
  QueryJsonPredicate,
  QueryLockMode,
  InsertQueryPlan,
  UpsertQueryPlan,
  QueryPlan,
  QueryPredicateNode,
  QueryUpdateValue,
  QueryVectorPredicate,
  SelectQueryPlan,
  UpdateQueryPlan,
} from './ast'

type IdentifierQuoter = (identifier: string) => string
type PlaceholderFactory = (index: number) => string

export class SQLQueryCompiler {
  constructor(
    protected readonly quoteIdentifier: IdentifierQuoter,
    protected readonly createPlaceholder: PlaceholderFactory,
  ) {}

  compile(plan: QueryPlan): CompiledStatement {
    validateQueryPlan(plan)

    switch (plan.kind) {
      case 'select':
        return this.compileSelect(plan)
      case 'insert':
        return this.compileInsert(plan)
      case 'update':
        return this.compileUpdate(plan)
      case 'upsert':
        return this.compileUpsert(plan)
      case 'delete':
        return this.compileDelete(plan)
      default:
        throw new CompilerError(`Unsupported query plan kind "${(plan as { kind: string }).kind}".`)
    }
  }

  protected compileSelect(plan: SelectQueryPlan): CompiledStatement {
    const bindings: unknown[] = []
    const sql = this.compileSelectSql(plan, bindings)
    return this.withMetadata({
      sql,
      bindings,
      unsafe: this.isUnsafeSelectPlan(plan) ? true : undefined,
      source: `query:select:${plan.source.tableName}`,
    }, this.createSelectMetadata(plan))
  }

  protected compileSelectSql(
    plan: SelectQueryPlan,
    bindings: unknown[],
  ): string {
    const selectKeyword = plan.distinct ? 'SELECT DISTINCT' : 'SELECT'
    const selectList = plan.selections.length === 0
      ? '*'
      : plan.selections.map((selection) => {
          if (selection.kind === 'subquery') {
            return `(${this.compileSelectSql(selection.query, bindings)}) AS ${this.quoteIdentifier(selection.alias)}`
          }

          if (selection.kind === 'aggregate') {
            const aggregateColumn = selection.column === '*'
              ? '*'
              : this.compileColumnReference(selection.column)
            return `${selection.aggregate.toUpperCase()}(${aggregateColumn}) AS ${this.quoteIdentifier(selection.alias)}`
          }

          if (selection.kind === 'raw') {
            bindings.push(...selection.bindings)
            return selection.sql
          }

          const column = this.compileColumnReference(selection.column)
          return selection.alias
            ? `${column} AS ${this.quoteIdentifier(selection.alias)}`
            : column
        }).join(', ')
    const joinClause = this.compileJoins(plan.joins, bindings)
    const whereClause = this.compilePredicates(plan.predicates, bindings)
    const unionClause = this.compileUnions(plan.unions, bindings)
    const groupByClause = plan.groupBy.length === 0
      ? ''
      : ` GROUP BY ${plan.groupBy.map(column => this.compileColumnReference(column)).join(', ')}`
    const havingClause = this.compileHaving(plan.having, bindings)
    const orderClause = plan.orderBy.length === 0
      ? ''
      : ` ORDER BY ${plan.orderBy.map(orderBy => this.compileOrderBy(orderBy, bindings)).join(', ')}`
    const lockClause = plan.lockMode ? ` ${this.compileLockClause(plan.lockMode)}` : ''
    const limitClause = typeof plan.limit === 'number' ? ` LIMIT ${plan.limit}` : ''
    const offsetClause = typeof plan.offset === 'number' ? ` OFFSET ${plan.offset}` : ''

    return `${selectKeyword} ${selectList} FROM ${this.compileSource(plan.source)}${joinClause}${whereClause}${groupByClause}${havingClause}${unionClause}${orderClause}${lockClause}${limitClause}${offsetClause}`
  }

  protected compileInsert(plan: InsertQueryPlan): CompiledStatement {
    const columns = Object.keys(plan.values[0]!)
    const bindings: unknown[] = []
    const rowsSql = plan.values.map((valueSet) => {
      const placeholders = columns.map((column) => {
        bindings.push(valueSet[column])
        return this.createPlaceholder(bindings.length)
      })
      return `(${placeholders.join(', ')})`
    }).join(', ')

    return this.withMetadata({
      sql: `${this.compileInsertPrefix(plan)} ${this.quoteIdentifier(plan.source.tableName)} (${columns.map(column => this.quoteIdentifier(column)).join(', ')}) VALUES ${rowsSql}${this.compileInsertSuffix(plan)}`,
      bindings,
      source: `query:insert:${plan.source.tableName}`,
    }, this.createWriteMetadata('insert', plan.source.tableName, this.calculatePlanComplexity(plan)))
  }

  protected compileUpsert(plan: UpsertQueryPlan): CompiledStatement {
    const columns = Object.keys(plan.values[0]!)
    const bindings: unknown[] = []
    const rowsSql = plan.values.map((valueSet) => {
      const placeholders = columns.map((column) => {
        bindings.push(valueSet[column])
        return this.createPlaceholder(bindings.length)
      })
      return `(${placeholders.join(', ')})`
    }).join(', ')

    return this.withMetadata({
      sql: `INSERT INTO ${this.quoteIdentifier(plan.source.tableName)} (${columns.map(column => this.quoteIdentifier(column)).join(', ')}) VALUES ${rowsSql}${this.compileUpsertSuffix(plan, columns)}`,
      bindings,
      source: `query:upsert:${plan.source.tableName}`,
    }, this.createWriteMetadata('upsert', plan.source.tableName, this.calculatePlanComplexity(plan)))
  }

  protected compileUpdate(plan: UpdateQueryPlan): CompiledStatement {
    const bindings: unknown[] = []
    const assignments = Object.keys(plan.values).map((column) => {
      return `${this.quoteIdentifier(column)} = ${this.compileUpdateValue(column, plan.values[column]!, bindings)}`
    }).join(', ')
    const whereClause = this.compilePredicates(plan.predicates, bindings)

    return this.withMetadata({
      sql: `UPDATE ${this.quoteIdentifier(plan.source.tableName)} SET ${assignments}${whereClause}`,
      bindings,
      source: `query:update:${plan.source.tableName}`,
    }, this.createWriteMetadata('update', plan.source.tableName, this.calculatePlanComplexity(plan)))
  }

  protected compileDelete(plan: DeleteQueryPlan): CompiledStatement {
    const bindings: unknown[] = []
    const whereClause = this.compilePredicates(plan.predicates, bindings)

    return this.withMetadata({
      sql: `DELETE FROM ${this.quoteIdentifier(plan.source.tableName)}${whereClause}`,
      bindings,
      source: `query:delete:${plan.source.tableName}`,
    }, this.createWriteMetadata('delete', plan.source.tableName, this.calculatePlanComplexity(plan)))
  }

  protected withMetadata(
    statement: CompiledStatement,
    metadata: CompiledStatementMetadata,
  ): CompiledStatement {
    Object.defineProperty(statement, 'metadata', {
      value: metadata,
      enumerable: false,
      configurable: true,
      writable: false,
    })
    return statement
  }

  protected createSelectMetadata(plan: SelectQueryPlan): CompiledStatementMetadata {
    const columnSelections = plan.selections.filter(selection => selection.kind === 'column')
    const aggregateSelections = plan.selections.filter(selection => selection.kind === 'aggregate')
    const complexity = this.calculatePlanComplexity(plan)

    return {
      kind: 'select',
      resultMode: 'rows',
      selectedShape: {
        mode: plan.selections.length === 0 ? 'all' : 'projection',
        columns: columnSelections.map(selection => selection.alias ?? selection.column),
        aggregates: aggregateSelections.map(selection => selection.alias),
        hasRawSelections: plan.selections.some(selection => selection.kind === 'raw'),
        hasSubqueries: plan.selections.some(selection => selection.kind === 'subquery'),
      },
      safety: {
        unsafe: this.isUnsafeSelectPlan(plan),
        containsRawSql: this.planContainsRawSql(plan),
      },
      debug: {
        tableName: plan.source.tableName,
        hasJoins: plan.joins.length > 0,
        hasUnions: plan.unions.length > 0,
        hasGrouping: plan.groupBy.length > 0,
        hasHaving: plan.having.length > 0,
        complexity,
        lockMode: plan.lockMode,
        intent: 'read',
        transactionAffinity: 'optional',
        streaming: 'buffered',
      },
    }
  }

  protected createWriteMetadata(
    kind: 'insert' | 'update' | 'upsert' | 'delete',
    tableName: string,
    complexity: number,
  ): CompiledStatementMetadata {
    return {
      kind,
      resultMode: 'write',
      selectedShape: {
        mode: 'write',
        columns: [],
        aggregates: [],
        hasRawSelections: false,
        hasSubqueries: false,
      },
      safety: {
        unsafe: false,
        containsRawSql: false,
      },
      debug: {
        tableName,
        hasJoins: false,
        hasUnions: false,
        hasGrouping: false,
        hasHaving: false,
        complexity,
        intent: 'write',
        transactionAffinity: 'required',
        streaming: 'buffered',
      },
    }
  }

  protected calculatePlanComplexity(plan: QueryPlan): number {
    switch (plan.kind) {
      case 'select':
        return 1
          + this.selectionComplexity(plan.selections)
          + plan.joins.length * 2
          + plan.unions.reduce((sum, union) => sum + 1 + this.calculatePlanComplexity(union.query), 0)
          + this.predicateComplexity(plan.predicates)
          + plan.groupBy.length
          + plan.having.length
          + plan.orderBy.length
          + (plan.lockMode ? 1 : 0)
          + (typeof plan.limit === 'number' ? 1 : 0)
          + (typeof plan.offset === 'number' ? 1 : 0)
      case 'insert': {
        const columnCount = Object.keys(plan.values[0]!).length
        return 1 + Math.max(1, columnCount) * Math.max(1, plan.values.length)
      }
      case 'upsert': {
        const columnCount = Object.keys(plan.values[0]!).length
        return 2
          + Math.max(1, columnCount) * Math.max(1, plan.values.length)
          + plan.uniqueBy.length
          + plan.updateColumns.length
      }
      case 'update':
        return 1 + Object.keys(plan.values).length + this.predicateComplexity(plan.predicates)
      case 'delete':
        return 1 + this.predicateComplexity(plan.predicates)
    }
  }

  private selectionComplexity(selections: readonly SelectQueryPlan['selections'][number][]): number {
    return selections.reduce((sum, selection) => {
      if (selection.kind === 'subquery') {
        return sum + 2 + this.calculatePlanComplexity(selection.query)
      }

      if (selection.kind === 'raw' || selection.kind === 'aggregate') {
        return sum + 2
      }

      return sum + 1
    }, 0)
  }

  private predicateComplexity(predicates: readonly QueryPredicateNode[]): number {
    return predicates.reduce((sum, predicate) => {
      if (predicate.kind === 'group') {
        return sum + 1 + this.predicateComplexity(predicate.predicates)
      }

      if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
        return sum + 2 + this.calculatePlanComplexity(predicate.subquery)
      }

      if (
        predicate.kind === 'json'
        || predicate.kind === 'fulltext'
        || predicate.kind === 'vector'
        || predicate.kind === 'raw'
      ) {
        return sum + 2
      }

      return sum + 1
    }, 0)
  }

  protected planContainsRawSql(plan: SelectQueryPlan): boolean {
    return plan.selections.some(selection => selection.kind === 'raw')
      || plan.predicates.some(predicate => this.predicateContainsRawSql(predicate))
      || plan.orderBy.some(orderBy => orderBy.kind === 'raw')
  }

  protected predicateContainsRawSql(predicate: QueryPredicateNode): boolean {
    if (predicate.kind === 'raw') {
      return true
    }

    if (predicate.kind === 'group') {
      return predicate.predicates.some(nested => this.predicateContainsRawSql(nested))
    }

    if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
      return this.planContainsRawSql(predicate.subquery)
    }

    return false
  }

  protected compilePredicates(
    predicates: readonly QueryPredicateNode[],
    bindings: unknown[],
  ): string {
    if (predicates.length === 0) return ''

    const clause = predicates.map((predicate, index) => {
      const compiled = this.compilePredicate(predicate, bindings)
      return this.prefixPredicate(predicate, compiled, index)
    }).join(' ')

    return ` WHERE ${clause}`
  }

  protected compileJoins(joins: readonly QueryJoinClause[], bindings: unknown[]): string {
    if (joins.length === 0) return ''

    return joins.map((join) => {
      const source = this.compileJoinSource(join, bindings)
      if (join.type === 'cross') {
        return ` CROSS JOIN ${source}`
      }

      if (join.lateral) {
        return ` ${join.type.toUpperCase()} JOIN ${source} ON TRUE`
      }

      return ` ${join.type.toUpperCase()} JOIN ${source} ON ${this.compileColumnReference(join.leftColumn!)} ${join.operator!.toUpperCase()} ${this.compileColumnReference(join.rightColumn!)}`
    }).join('')
  }

  protected compileUnions(unions: SelectQueryPlan['unions'], bindings: unknown[]): string {
    if (unions.length === 0) return ''

    return unions.map((union) => {
      const keyword = union.all ? ' UNION ALL ' : ' UNION '
      return `${keyword}${this.compileSelectSql(union.query, bindings)}`
    }).join('')
  }

  protected compileHaving(
    clauses: readonly QueryHavingClause[],
    bindings: unknown[],
  ): string {
    if (clauses.length === 0) return ''

    const compiled = clauses.map((clause) => {
      if (clause.operator === 'between' || clause.operator === 'not between') {
        const values = clause.value as readonly [unknown, unknown]
        bindings.push(values[0], values[1])
        return `${this.compileHavingExpression(clause.expression)} ${clause.operator.toUpperCase()} ${this.createPlaceholder(bindings.length - 1)} AND ${this.createPlaceholder(bindings.length)}`
      }

      bindings.push(clause.value)
      return `${this.compileHavingExpression(clause.expression)} ${clause.operator.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }).join(' AND ')

    return ` HAVING ${compiled}`
  }

  protected compilePredicate(
    predicate: QueryPredicateNode,
    bindings: unknown[],
  ): string {
    if (predicate.kind === 'group') {
      const nested = this.compilePredicateSequence(predicate.predicates, bindings)
      return predicate.negated ? `NOT (${nested})` : `(${nested})`
    }

    if (predicate.kind === 'raw') {
      bindings.push(...predicate.bindings)
      return predicate.sql
    }

    if (predicate.kind === 'exists') {
      const nested = this.compileSelectSql(predicate.subquery, bindings)
      return `${predicate.negated ? 'NOT ' : ''}EXISTS (${nested})`
    }

    if (predicate.kind === 'subquery') {
      const nested = this.compileSelectSql(predicate.subquery, bindings)
      const column = this.compileColumnReference(predicate.column)
      if (predicate.operator === 'in' || predicate.operator === 'not in') {
        return `${column} ${predicate.operator.toUpperCase()} (${nested})`
      }

      return `${column} ${predicate.operator.toUpperCase()} (${nested})`
    }

    if (predicate.kind === 'date') {
      bindings.push(predicate.value)
      return this.compileDatePredicate(predicate, this.createPlaceholder(bindings.length))
    }

    if (predicate.kind === 'json') {
      return this.compileJsonPredicate(predicate, bindings)
    }

    if (predicate.kind === 'fulltext') {
      return this.compileFullTextPredicate(predicate, bindings)
    }

    if (predicate.kind === 'vector') {
      return this.compileVectorPredicate(predicate, bindings)
    }

    if (predicate.kind === 'null') {
      return `${this.compileColumnReference(predicate.column)} IS ${predicate.negated ? 'NOT ' : ''}NULL`
    }

    if (predicate.kind === 'column') {
      return `${this.compileColumnReference(predicate.column)} ${predicate.operator.toUpperCase()} ${this.compileColumnReference(predicate.compareTo)}`
    }

    if (predicate.operator === 'in' || predicate.operator === 'not in') {
      const values = predicate.value as readonly unknown[]
      const placeholders = values.map((value) => {
        bindings.push(value)
        return this.createPlaceholder(bindings.length)
      }).join(', ')
      return `${this.compileColumnReference(predicate.column)} ${predicate.operator.toUpperCase()} (${placeholders})`
    }

    if (predicate.operator === 'between' || predicate.operator === 'not between') {
      const values = predicate.value as readonly [unknown, unknown]
      bindings.push(values[0], values[1])
      return `${this.compileColumnReference(predicate.column)} ${predicate.operator.toUpperCase()} ${this.createPlaceholder(bindings.length - 1)} AND ${this.createPlaceholder(bindings.length)}`
    }

    bindings.push(predicate.value)
    return `${this.compileColumnReference(predicate.column)} ${predicate.operator.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
  }

  protected compileDatePredicate(
    predicate: QueryDatePredicate,
    placeholder: string,
  ): string {
    const column = this.compileColumnReference(predicate.column)
    switch (predicate.part) {
      case 'date':
        return `DATE(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'time':
        return `TIME(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'year':
        return `EXTRACT(YEAR FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'month':
        return `EXTRACT(MONTH FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'day':
        return `EXTRACT(DAY FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      default:
        throw new CompilerError(`Unsupported date predicate part "${(predicate as QueryDatePredicate).part}".`)
    }
  }

  protected compileJsonPredicate(
    predicate: QueryJsonPredicate,
    _bindings: unknown[],
  ): string {
    throw new CompilerError(`Dialect does not implement JSON predicate compilation for "${predicate.column}".`)
  }

  protected compileFullTextPredicate(
    predicate: QueryFullTextPredicate,
    _bindings: unknown[],
  ): string {
    throw new CompilerError(`Dialect does not implement full-text predicate compilation for "${predicate.columns.join(', ')}".`)
  }

  protected compileVectorPredicate(
    predicate: QueryVectorPredicate,
    bindings: unknown[],
  ): string {
    const distance = this.compileVectorDistanceExpression(predicate.column, predicate.vector, bindings)
    bindings.push(1 - predicate.minSimilarity)
    return `${distance} <= ${this.createPlaceholder(bindings.length)}`
  }

  protected compileOrderBy(orderBy: SelectQueryPlan['orderBy'][number], bindings: unknown[]): string {
    if (orderBy.kind === 'random') {
      return this.compileRandomOrder()
    }

    if (orderBy.kind === 'raw') {
      bindings.push(...orderBy.bindings)
      return orderBy.sql
    }

    if (orderBy.kind === 'vector') {
      return `${this.compileVectorDistanceExpression(orderBy.column, orderBy.vector, bindings)} ASC`
    }

    return `${this.compileColumnReference(orderBy.column)} ${orderBy.direction.toUpperCase()}`
  }

  protected compileRandomOrder(): string {
    return 'RANDOM()'
  }

  protected compileInsertPrefix(_plan: InsertQueryPlan): string {
    return 'INSERT INTO'
  }

  protected compileInsertSuffix(_plan: InsertQueryPlan): string {
    return ''
  }

  protected compileUpsertSuffix(plan: UpsertQueryPlan, _insertColumns: readonly string[]): string {
    const conflictColumns = plan.uniqueBy.map(column => this.quoteIdentifier(column)).join(', ')
    if (plan.updateColumns.length === 0) {
      return ` ON CONFLICT (${conflictColumns}) DO NOTHING`
    }

    const updates = plan.updateColumns
      .map(column => `${this.quoteIdentifier(column)} = EXCLUDED.${this.quoteIdentifier(column)}`)
      .join(', ')
    return ` ON CONFLICT (${conflictColumns}) DO UPDATE SET ${updates}`
  }

  protected compileHavingExpression(expression: string): string {
    const aggregateMatch = expression.match(/^(count|sum|avg|min|max)\((\*|[A-Z_]\w*)\)$/i)
    if (aggregateMatch) {
      const [, fn, column] = aggregateMatch
      if (column === '*') {
        return `${fn!.toUpperCase()}(*)`
      }
      return `${fn!.toUpperCase()}(${this.compileColumnReference(column!)})`
    }

    return this.compileColumnReference(expression)
  }

  protected compileColumnReference(reference: string): string {
    if (!reference.includes('.')) {
      return this.quoteIdentifier(reference)
    }

    return reference
      .split('.')
      .map(part => this.quoteIdentifier(part))
      .join('.')
  }

  protected compileTableReference(reference: string): string {
    return this.compileColumnReference(reference)
  }

  protected compileSource(source: SelectQueryPlan['source']): string {
    const table = this.compileTableReference(source.tableName)
    return source.alias
      ? `${table} AS ${this.quoteIdentifier(source.alias)}`
      : table
  }

  protected compileJoinSource(join: QueryJoinClause, bindings: unknown[]): string {
    if (join.subquery) {
      const subquery = `(${this.compileSelectSql(join.subquery, bindings)})`
      if (join.lateral) {
        return this.compileLateralJoinSource(subquery, join.alias!)
      }

      return `${subquery} AS ${this.quoteIdentifier(join.alias!)}`
    }

    return this.compileTableReference(join.table!)
  }

  protected compileLateralJoinSource(_subquery: string, _alias: string): string {
    throw new CompilerError('The active dialect does not support lateral joins.')
  }

  protected compileUpdateValue(
    column: string,
    value: QueryUpdateValue,
    bindings: unknown[],
  ): string {
    if (Array.isArray(value)) {
      return this.compileJsonUpdateOperations(column, value, bindings)
    }

    if (this.isJsonUpdateOperation(value)) {
      return this.compileJsonUpdateOperations(column, [value], bindings)
    }

    bindings.push(value)
    return this.createPlaceholder(bindings.length)
  }

  protected compileJsonUpdateOperations(
    column: string,
    _operations: readonly QueryJsonUpdateOperation[],
    _bindings: unknown[],
  ): string {
    throw new CompilerError(`Dialect does not implement JSON update compilation for "${column}".`)
  }

  protected compileVectorDistanceExpression(_column: string, _vector: readonly number[], _bindings: unknown[]): string {
    throw new CompilerError('The active dialect does not support vector similarity clauses.')
  }

  protected compileLockClause(_lockMode: QueryLockMode): string {
    throw new CompilerError('The active dialect does not support pessimistic lock clauses.')
  }

  protected escapeSqlString(value: string): string {
    return value.replaceAll('\'', '\'\'')
  }

  protected createSqlStringLiteral(value: string): string {
    return `'${this.escapeSqlString(value)}'`
  }

  protected createJsonPathLiteral(path: readonly string[]): string {
    const serializedPath = path.reduce((current, segment) => {
      if (/^[A-Z_]\w*$/i.test(segment)) {
        return `${current}.${segment}`
      }

      return `${current}["${segment.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`
    }, '$')

    return this.createSqlStringLiteral(serializedPath)
  }

  protected createPostgresPathLiteral(path: readonly string[]): string {
    const serializedPath = path.map(segment => segment.replaceAll('"', '\\"')).join(',')
    return this.createSqlStringLiteral(`{${serializedPath}}`)
  }

  protected isJsonUpdateOperation(value: QueryUpdateValue): value is QueryJsonUpdateOperation {
    return typeof value === 'object' && value !== null && 'kind' in value && (value as { kind?: unknown }).kind === 'json-set'
  }

  protected isUnsafeSelectPlan(plan: SelectQueryPlan): boolean {
    const hasUnsafeSelection = plan.selections.some(selection => (
      selection.kind === 'raw'
      || (selection.kind === 'subquery' && this.isUnsafeSelectPlan(selection.query))
    ))
    const hasUnsafePredicate = plan.predicates.some(predicate => this.isUnsafePredicate(predicate))
    const hasUnsafeOrder = plan.orderBy.some(orderBy => orderBy.kind === 'raw')
    const hasUnsafeUnion = plan.unions.some(union => this.isUnsafeSelectPlan(union.query))
    const hasUnsafeJoin = plan.joins.some(join => typeof join.subquery !== 'undefined' && this.isUnsafeSelectPlan(join.subquery))
    return hasUnsafeSelection || hasUnsafePredicate || hasUnsafeOrder || hasUnsafeUnion || hasUnsafeJoin
  }

  protected isUnsafePredicate(predicate: QueryPredicateNode): boolean {
    if (predicate.kind === 'raw') {
      return true
    }

    if (predicate.kind === 'group') {
      return predicate.predicates.some(nested => this.isUnsafePredicate(nested))
    }

    if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
      return this.isUnsafeSelectPlan(predicate.subquery)
    }

    return false
  }

  private compilePredicateSequence(
    predicates: readonly QueryPredicateNode[],
    bindings: unknown[],
  ): string {
    return predicates.map((predicate, index) => {
      const compiled = this.compilePredicate(predicate, bindings)
      return this.prefixPredicate(predicate, compiled, index)
    }).join(' ')
  }

  protected prefixPredicate(
    predicate: QueryPredicateNode,
    compiled: string,
    index: number,
  ): string {
    if (index === 0) {
      return compiled
    }

    const boolean = (predicate.boolean ?? 'and').toUpperCase()
    return `${boolean} ${compiled}`
  }
}
