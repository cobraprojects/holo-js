import { SQLQueryCompiler } from './SQLQueryCompiler'
import type { InsertQueryPlan, QueryDatePredicate, QueryJsonPredicate, QueryJsonUpdateOperation } from './ast'

function createSqliteJsonExtractExpression(column: string, pathLiteral: string): string {
  return `json_extract(${column}, ${pathLiteral})`
}

function compileSqliteJsonValuePredicate(
  extracted: string,
  predicate: QueryJsonPredicate,
  bindings: unknown[],
  createPlaceholder: (index: number) => string,
): string {
  bindings.push(predicate.value)
  const operator = predicate.operator!.toUpperCase()
  const placeholder = createPlaceholder(bindings.length)
  return `${extracted} ${operator} ${placeholder}`
}
const SQLITE_JSON_HELPERS = Object.freeze({
  compileValuePredicate: compileSqliteJsonValuePredicate,
  createExtractExpression: createSqliteJsonExtractExpression,
})
const SQLITE_EMPTY_JSON_OBJECT = 'json(\'{}\')'

export class SQLiteQueryCompiler extends SQLQueryCompiler {
  protected override compileJsonPredicate(predicate: QueryJsonPredicate, bindings: unknown[]): string {
    const column = this.compileColumnReference(predicate.column)
    const pathLiteral = this.createJsonPathLiteral(predicate.path)

    if (predicate.jsonMode === 'value') {
      return SQLITE_JSON_HELPERS.compileValuePredicate(
        SQLITE_JSON_HELPERS.createExtractExpression(column, pathLiteral),
        predicate,
        bindings,
        index => this.createPlaceholder(index),
      )
    }

    if (predicate.jsonMode === 'contains') {
      const extracted = SQLITE_JSON_HELPERS.createExtractExpression(column, pathLiteral)
      if (predicate.value === null || ['string', 'number', 'boolean'].includes(typeof predicate.value)) {
        bindings.push(predicate.value)
        return `EXISTS (SELECT 1 FROM json_each(${extracted}) WHERE value = ${this.createPlaceholder(bindings.length)})`
      }

      bindings.push(JSON.stringify(predicate.value))
      return `${extracted} = json(${this.createPlaceholder(bindings.length)})`
    }

    bindings.push(predicate.value)
    return `json_array_length(${SQLITE_JSON_HELPERS.createExtractExpression(column, pathLiteral)}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
  }

  protected override compileJsonUpdateOperations(
    column: string,
    operations: readonly QueryJsonUpdateOperation[],
    bindings: unknown[],
  ): string {
    let expression = `COALESCE(${this.compileColumnReference(column)}, ${SQLITE_EMPTY_JSON_OBJECT})`

    for (const operation of operations) {
      bindings.push(JSON.stringify(operation.value))
      expression = `json_set(${expression}, ${this.createJsonPathLiteral(operation.path)}, json(${this.createPlaceholder(bindings.length)}))`
    }

    return expression
  }

  protected override compileDatePredicate(
    predicate: QueryDatePredicate,
    placeholder: string,
  ): string {
    const column = this.compileColumnReference(predicate.column)
    switch (predicate.part) {
      case 'date':
        return `date(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'time':
        return `time(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'year':
        return `strftime('%Y', ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'month':
        return `strftime('%m', ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'day':
        return `strftime('%d', ${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      default:
        return super.compileDatePredicate(predicate, placeholder)
    }
  }

  protected override compileInsertPrefix(plan: InsertQueryPlan): string {
    return plan.ignoreConflicts ? 'INSERT OR IGNORE INTO' : 'INSERT INTO'
  }
}
