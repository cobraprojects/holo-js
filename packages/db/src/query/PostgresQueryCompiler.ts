import { SQLQueryCompiler } from './SQLQueryCompiler'
import type {
  InsertQueryPlan,
  QueryDatePredicate,
  QueryFullTextPredicate,
  QueryJsonPredicate,
  QueryJsonUpdateOperation,
  QueryLockMode,
  UpsertQueryPlan,
} from './ast'

export class PostgresQueryCompiler extends SQLQueryCompiler {
  protected override compileLateralJoinSource(subquery: string, alias: string): string {
    return `LATERAL ${subquery} AS ${this.quoteIdentifier(alias)}`
  }

  protected override compileLockClause(lockMode: QueryLockMode): string {
    return lockMode === 'update' ? 'FOR UPDATE' : 'FOR SHARE'
  }

  protected override compileInsertSuffix(plan: InsertQueryPlan): string {
    const primaryKey = Object.values(plan.source.table?.columns ?? {})
      .find(column => column.primaryKey)?.name
    const returning = primaryKey ? ` RETURNING ${this.quoteIdentifier(primaryKey)}` : ''
    return `${plan.ignoreConflicts ? ' ON CONFLICT DO NOTHING' : ''}${returning}`
  }

  protected override compileUpsertSuffix(plan: UpsertQueryPlan, insertColumns: readonly string[]): string {
    const suffix = super.compileUpsertSuffix(plan, insertColumns)
    const primaryKey = Object.values(plan.source.table?.columns ?? {})
      .find(column => column.primaryKey)?.name
    return primaryKey
      ? `${suffix} RETURNING ${this.quoteIdentifier(primaryKey)}`
      : suffix
  }

  protected override compileJsonPredicate(
    predicate: QueryJsonPredicate,
    bindings: unknown[],
  ): string {
    const column = this.compileColumnReference(predicate.column)
    const root = `(${column})::jsonb`
    const extractedText = predicate.path.length === 0
      ? `${root} #>> '{}'`
      : `${root} #>> ${this.createPostgresPathLiteral(predicate.path)}`
    const extractedJson = predicate.path.length === 0
      ? root
      : `jsonb_extract_path(${root}, ${predicate.path.map(segment => this.createSqlStringLiteral(segment)).join(', ')})`

    if (predicate.jsonMode === 'value') {
      bindings.push(predicate.value)
      return `${extractedText} ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }

    if (predicate.jsonMode === 'contains') {
      bindings.push(JSON.stringify(predicate.value))
      return `${extractedJson} @> ${this.createPlaceholder(bindings.length)}::jsonb`
    }

    bindings.push(predicate.value)
    return `jsonb_array_length(${extractedJson}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
  }

  protected override compileJsonUpdateOperations(
    column: string,
    operations: readonly QueryJsonUpdateOperation[],
    bindings: unknown[],
  ): string {
    let expression = `COALESCE((${this.compileColumnReference(column)})::jsonb, '{}'::jsonb)`

    for (const operation of operations) {
      bindings.push(JSON.stringify(operation.value))
      expression = `jsonb_set(${expression}, ${this.createPostgresPathLiteral(operation.path)}, CAST(${this.createPlaceholder(bindings.length)} AS jsonb), true)`
    }

    return expression
  }

  protected override compileFullTextPredicate(
    predicate: QueryFullTextPredicate,
    bindings: unknown[],
  ): string {
    const document = predicate.columns.length === 1
      ? this.compileColumnReference(predicate.columns[0]!)
      : `concat_ws(' ', ${predicate.columns.map(column => this.compileColumnReference(column)).join(', ')})`
    bindings.push(predicate.value)
    const placeholder = this.createPlaceholder(bindings.length)
    const query = predicate.mode === 'boolean'
      ? `to_tsquery(${placeholder})`
      : `websearch_to_tsquery(${placeholder})`
    return `to_tsvector(${document}) @@ ${query}`
  }

  protected override compileVectorDistanceExpression(
    column: string,
    vector: readonly number[],
    bindings: unknown[],
  ): string {
    bindings.push(`[${vector.join(',')}]`)
    return `${this.compileColumnReference(column)} <=> CAST(${this.createPlaceholder(bindings.length)} AS vector)`
  }

  protected override compileDatePredicate(
    predicate: QueryDatePredicate,
    placeholder: string,
  ): string {
    const column = this.compileColumnReference(predicate.column)
    switch (predicate.part) {
      case 'date':
        return `CAST(${column} AS DATE) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'time':
        return `CAST(${column} AS TIME) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'year':
        return `EXTRACT(YEAR FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'month':
        return `EXTRACT(MONTH FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'day':
        return `EXTRACT(DAY FROM ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      default:
        return super.compileDatePredicate(predicate, placeholder)
    }
  }
}
