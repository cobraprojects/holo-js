import { SQLQueryCompiler } from './SQLQueryCompiler'
import type { InsertQueryPlan, QueryDatePredicate, QueryJsonPredicate, QueryJsonUpdateOperation, QueryLockMode } from './ast'

function createSqliteJsonExtractExpression(column: string, pathLiteral: string): string {
  return `json_extract(${column}, ${pathLiteral})`
}

function sqliteJsonType(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return 'number'
  return 'text'
}

function compileSqliteJsonEquality(
  extracted: string,
  extractedType: string,
  operator: '=' | '!=',
  value: unknown,
  placeholder: string,
): string {
  const valueType = sqliteJsonType(value)
  const matchingType = valueType === 'number'
    ? `${extractedType} IN ('integer', 'real')`
    : `${extractedType} = '${valueType}'`

  if (operator === '=') {
    return `${matchingType} AND ${extracted} = ${placeholder}`
  }

  const differingType = valueType === 'number'
    ? `${extractedType} NOT IN ('integer', 'real')`
    : `${extractedType} != '${valueType}'`
  return `${extractedType} IS NOT NULL AND (${differingType} OR ${extracted} != ${placeholder})`
}

const SQLITE_EMPTY_JSON_OBJECT = 'json(\'{}\')'

export class SQLiteQueryCompiler extends SQLQueryCompiler {
  protected override compileLockClause(_lockMode: QueryLockMode): string {
    return ''
  }

  protected override compileJsonPredicate(predicate: QueryJsonPredicate, bindings: unknown[]): string {
    const column = this.compileColumnReference(predicate.column)
    const pathLiteral = this.createJsonPathLiteral(predicate.path)
    const extracted = createSqliteJsonExtractExpression(column, pathLiteral)

    if (predicate.jsonMode === 'value') {
      if (predicate.value === null) {
        const extractedType = `json_type(${column}, ${pathLiteral})`
        return predicate.operator === '='
          ? `${extractedType} = 'null'`
          : `${extractedType} IS NOT NULL AND ${extractedType} != 'null'`
      }

      if (predicate.operator === '=' || predicate.operator === '!=') {
        bindings.push(typeof predicate.value === 'boolean' ? Number(predicate.value) : predicate.value)
        return compileSqliteJsonEquality(
          extracted,
          `json_type(${column}, ${pathLiteral})`,
          predicate.operator,
          predicate.value,
          this.createPlaceholder(bindings.length),
        )
      }

      bindings.push(predicate.value)
      return `${extracted} ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }

    if (predicate.jsonMode === 'contains') {
      if (predicate.value === null || ['string', 'number', 'boolean'].includes(typeof predicate.value)) {
        bindings.push(predicate.value)
        return `EXISTS (SELECT 1 FROM json_each(${extracted}) WHERE value = ${this.createPlaceholder(bindings.length)})`
      }

      bindings.push(JSON.stringify(predicate.value))
      return `${extracted} = json(${this.createPlaceholder(bindings.length)})`
    }

    bindings.push(predicate.value)
    return `json_array_length(${extracted}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
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
