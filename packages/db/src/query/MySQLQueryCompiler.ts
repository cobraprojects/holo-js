import { SQLQueryCompiler } from './SQLQueryCompiler'
import type { InsertQueryPlan, QueryDatePredicate, QueryFullTextPredicate, QueryJsonPredicate, QueryJsonUpdateOperation, QueryLockMode, UpsertQueryPlan } from './ast'

export class MySQLQueryCompiler extends SQLQueryCompiler {
  protected override compileLateralJoinSource(subquery: string, alias: string): string {
    return `LATERAL ${subquery} ${this.quoteIdentifier(alias)}`
  }

  protected override compileLockClause(lockMode: QueryLockMode): string {
    return lockMode === 'update' ? 'FOR UPDATE' : 'LOCK IN SHARE MODE'
  }

  protected override compileInsertPrefix(plan: InsertQueryPlan): string {
    return plan.ignoreConflicts ? 'INSERT IGNORE INTO' : 'INSERT INTO'
  }

  protected override compileUpsertSuffix(plan: UpsertQueryPlan, insertColumns: readonly string[]): string {
    let updateColumns = plan.updateColumns
    if (updateColumns.length === 0) {
      updateColumns = [plan.uniqueBy[0] ?? insertColumns[0]!]
    }
    const updates = updateColumns
      .map(column => `${this.quoteIdentifier(column)} = VALUES(${this.quoteIdentifier(column)})`)
      .join(', ')
    return ` ON DUPLICATE KEY UPDATE ${updates}`
  }

  protected override compileRandomOrder(): string {
    return 'RAND()'
  }

  protected override compileJsonPredicate(
    predicate: QueryJsonPredicate,
    bindings: unknown[],
  ): string {
    const column = this.compileColumnReference(predicate.column)
    const pathLiteral = this.createJsonPathLiteral(predicate.path)
    const extracted = `JSON_EXTRACT(${column}, ${pathLiteral})`

    if (predicate.jsonMode === 'value') {
      bindings.push(predicate.value)
      return `JSON_UNQUOTE(${extracted}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }

    if (predicate.jsonMode === 'contains') {
      bindings.push(JSON.stringify(predicate.value))
      return `JSON_CONTAINS(${extracted}, CAST(${this.createPlaceholder(bindings.length)} AS JSON))`
    }

    bindings.push(predicate.value)
    return `JSON_LENGTH(${extracted}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
  }

  protected override compileJsonUpdateOperations(
    column: string,
    operations: readonly QueryJsonUpdateOperation[],
    bindings: unknown[],
  ): string {
    let expression = `COALESCE(${this.compileColumnReference(column)}, JSON_OBJECT())`

    for (const operation of operations) {
      bindings.push(JSON.stringify(operation.value))
      expression = `JSON_SET(${expression}, ${this.createJsonPathLiteral(operation.path)}, CAST(${this.createPlaceholder(bindings.length)} AS JSON))`
    }

    return expression
  }

  protected override compileFullTextPredicate(
    predicate: QueryFullTextPredicate,
    bindings: unknown[],
  ): string {
    const columns = predicate.columns.map(column => this.compileColumnReference(column)).join(', ')
    bindings.push(predicate.value)
    const modifier = predicate.mode === 'boolean'
      ? ' IN BOOLEAN MODE'
      : ' IN NATURAL LANGUAGE MODE'
    return `MATCH (${columns}) AGAINST (${this.createPlaceholder(bindings.length)}${modifier})`
  }

  protected override compileDatePredicate(
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
        return super.compileDatePredicate(predicate, placeholder)
    }
  }
}
