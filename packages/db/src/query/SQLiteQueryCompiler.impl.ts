import { SQLQueryCompiler } from './SQLQueryCompiler'
import { compileSQLiteWallClock, formatSQLiteDateTime } from '../sqliteDateTime'
import { getApplicationTimezone } from '../applicationTimezone'
import type { CompiledStatement } from '../core/types'
import { CompilerError } from '../core/errors'
import { splitTablePath } from '../schema/identifiers'
import { sameIdentifier } from '../schema/introspection/sqliteTokens'
import type { InsertStatementOptions, QueryColumnPredicate, QueryDatePredicate, QueryJsonPredicate, QueryLikePredicate, QueryJsonUpdateOperation, QueryLockMode, QueryPredicate, SelectQueryPlan } from './ast'

function createSqliteJsonExtractExpression(column: string, pathLiteral: string): string {
  return `json_extract(${column}, ${pathLiteral})`
}

function escapeSqliteJsonLabel(segment: string): string {
  return segment
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\u0000', '\\u0000')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, unit => `\\u${unit.charCodeAt(0).toString(16)}`)
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

const SQLITE_GLOB_PATTERN_REPLACEMENTS: Readonly<Record<string, string>> = {
  '[': '[[]',
  '*': '[*]',
  '?': '[?]',
  '%': '*',
  '_': '?',
}

function convertLikePatternToGlob(pattern: string): string {
  return pattern.replace(/[[*?%_]/g, character => SQLITE_GLOB_PATTERN_REPLACEMENTS[character] ?? character)
}

function splitSchemaTable(tableName: string): { readonly schemaName: string, readonly schema: string, readonly table: string } {
  const separator = tableName.indexOf('.')
  if (separator === -1) {
    return { schemaName: 'main', schema: '', table: tableName }
  }

  const schemaName = tableName.slice(0, separator)
  return { schemaName, schema: `"${schemaName.replaceAll('"', '""')}".`, table: tableName.slice(separator + 1) }
}

const SQLITE_EMPTY_JSON_OBJECT = 'json(\'{}\')'

export class SQLiteQueryCompiler extends SQLQueryCompiler {
  protected override readonly dialect = 'sqlite'

  protected override createDateLiteral(value: Date): string {
    return this.createSqlStringLiteral(formatSQLiteDateTime(value))
  }

  override compileTableSchemaLookup(tableName: string): CompiledStatement | undefined {
    if (tableName.includes('.')) return undefined

    return {
      sql: 'SELECT "tables"."schema" AS "schema" FROM pragma_table_list(?) AS "tables" JOIN pragma_database_list AS "databases" ON "databases"."name" = "tables"."schema" ORDER BY CASE "tables"."schema" WHEN \'temp\' THEN 0 ELSE 1 END, "databases"."seq" LIMIT 1',
      bindings: [tableName],
      source: `query:select:${tableName}`,
    }
  }

  override compileTableIdentityLookup(tableName: string): CompiledStatement {
    const { schema, table } = splitTablePath(tableName)
    const resolve = (schemaFilter: string) => `SELECT "tables"."schema" AS "schema", "tables"."name" AS "name" FROM pragma_table_list AS "tables" JOIN pragma_database_list AS "databases" ON "databases"."name" = "tables"."schema" WHERE "tables"."name" = ? COLLATE NOCASE ${schemaFilter}ORDER BY CASE "tables"."schema" WHEN 'temp' THEN 0 ELSE 1 END, "databases"."seq" LIMIT 1`
    return {
      sql: `SELECT "resolved"."schema" AS "schema", "resolved"."name" AS "name", (SELECT "bare"."schema" FROM (${resolve('')}) AS "bare") AS "bare_schema" FROM (SELECT 1) AS "probe" LEFT JOIN (${resolve(schema === undefined ? '' : 'AND "tables"."schema" = ? COLLATE NOCASE ')}) AS "resolved" ON 1 = 1`,
      bindings: schema === undefined ? [table, table] : [table, table, schema],
      source: `schema:introspect:tableIdentity:${tableName}`,
    }
  }

  override compileSequenceReset(tableName: string): { readonly probe: CompiledStatement, readonly reset: CompiledStatement } {
    const { schema, table } = splitSchemaTable(tableName)
    return {
      probe: {
        sql: `SELECT 1 AS "present" FROM ${schema}"sqlite_master" WHERE "type" = 'table' AND "name" = 'sqlite_sequence'`,
        bindings: [],
        source: `query:select:${tableName}`,
      },
      reset: {
        sql: `DELETE FROM ${schema}"sqlite_sequence" WHERE "name" = ? COLLATE NOCASE`,
        bindings: [table],
        source: `query:delete:${tableName}`,
      },
    }
  }

  override compileReferencingTables(tableName: string): CompiledStatement {
    const { schemaName, schema, table } = splitSchemaTable(tableName)
    return {
      sql: `SELECT DISTINCT "tables"."name" AS "name" FROM ${schema}"sqlite_master" AS "tables", pragma_foreign_key_list("tables"."name", ?) AS "keys" WHERE "tables"."type" = 'table' AND lower("keys"."table") = lower(?) AND lower("tables"."name") != lower(?)`,
      bindings: [schemaName, table, table],
      source: `query:select:${tableName}`,
    }
  }

  protected override compileAllColumnsOf(tableReference: string, plan: SelectQueryPlan): string {
    const requested = splitTablePath(tableReference)
    if (requested.schema === undefined) return super.compileAllColumnsOf(tableReference, plan)
    const sources = [plan.source, ...plan.joins.map(join => ({ tableName: join.table, alias: join.alias }))]
    const named = (source: { tableName?: string }) => {
      const path = source.tableName === undefined ? undefined : splitTablePath(source.tableName)
      return path?.schema !== undefined && sameIdentifier(path.schema, requested.schema) && sameIdentifier(path.table, requested.table)
    }
    const expanded = sources.filter(source => sameIdentifier(requested.table, source.alias ?? (source.tableName === undefined ? undefined : splitTablePath(source.tableName).table)))
    if (expanded.length > 1) {
      throw new CompilerError(`SQLite cannot select "${tableReference}.*" because more than one table in the query is named "${requested.table}". Alias the tables and select "alias.*" instead.`)
    }
    if (expanded.length === 1 && expanded[0]!.alias === undefined && named(expanded[0]!)) {
      return `${this.quoteIdentifier(requested.table)}.*`
    }
    const aliased = sources.find(source => source.alias !== undefined && named(source))
    if (aliased) {
      throw new CompilerError(`SQLite cannot select "${tableReference}.*" because table "${tableReference}" is aliased as "${aliased.alias}". Select "${aliased.alias}.*" instead.`)
    }
    throw new CompilerError(`SQLite cannot select "${tableReference}.*" because no table in the query is "${tableReference}" without an alias. Qualify the table the same way or select "${requested.table}.*".`)
  }

  protected override compileLikePredicate(predicate: QueryLikePredicate, bindings: unknown[]): string {
    if (!predicate.caseSensitive) {
      return super.compileLikePredicate(predicate, bindings)
    }

    bindings.push(convertLikePatternToGlob(predicate.value))
    return `${this.compileLikeSubject(predicate)} ${predicate.negated ? 'NOT ' : ''}GLOB ${this.createPlaceholder(bindings.length)}`
  }

  protected override compileJsonTextExtraction(column: string, path: readonly string[]): string {
    return createSqliteJsonExtractExpression(column, this.createJsonPathLiteral(path))
  }

  protected override compileLockClause(_lockMode: QueryLockMode): string {
    return ''
  }

  protected override createJsonPathLiteral(path: readonly string[]): string {
    const serializedPath = path.reduce((current, segment) => {
      if (/^[A-Z_]\w*$/i.test(segment)) {
        return `${current}.${segment}`
      }

      return `${current}."${escapeSqliteJsonLabel(segment)}"`
    }, '$')

    return this.createSqlStringLiteral(serializedPath)
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

    if (predicate.jsonMode === 'key') {
      return `json_type(${column}, ${pathLiteral}) IS NOT NULL`
    }

    if (predicate.jsonMode === 'contains') {
      if (predicate.value === null || ['string', 'number', 'boolean'].includes(typeof predicate.value)) {
        bindings.push(predicate.value)
        return `EXISTS (SELECT 1 FROM json_each(${extracted}) WHERE value = ${this.createPlaceholder(bindings.length)})`
      }

      bindings.push(JSON.stringify(predicate.value))
      return `COALESCE(${extracted} = json(${this.createPlaceholder(bindings.length)}), 0)`
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

  private compileAppWallClock(column: string): string {
    const timeZone = getApplicationTimezone()
    if (timeZone === 'UTC') return column

    const wallClock = compileSQLiteWallClock(column, this.createSqlStringLiteral(timeZone))
    return `CASE WHEN ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN ${column} ELSE ${wallClock} END`
  }

  protected override compileIntegerKey(expression: string): string {
    const point = `instr(${expression}, '.')`
    const integer = `CASE WHEN ${point} > 0 THEN substr(${expression}, 1, ${point} - 1) ELSE ${expression} END`
    const digits = `CASE WHEN ${integer} GLOB '-*' THEN substr(${integer}, 2) ELSE ${integer} END`
    const fraction = `substr(${expression}, ${point} + 1)`
    const limit = `CASE WHEN ${integer} GLOB '-*' THEN '9223372036854775808' ELSE '9223372036854775807' END`
    const inRange = `(length(${digits}) < 19 OR (length(${digits}) = 19 AND ${digits} <= ${limit}))`
    return `CASE WHEN instr(CAST(${expression} AS BLOB), x'00') = 0 AND ${digits} <> '' AND ${digits} NOT GLOB '*[^0-9]*' AND (${digits} = '0' OR ${digits} NOT GLOB '0*') AND ${inRange} AND (${point} = 0 OR (${fraction} <> '' AND ${fraction} NOT GLOB '*[^0]*')) THEN CAST(${integer} AS INTEGER) END`
  }

  protected override compileColumnComparison(predicate: QueryColumnPredicate): string {
    if (!predicate.dateOperands) return super.compileColumnComparison(predicate)

    const column = this.compileWallClockOperand(predicate.column, predicate.dateOperands.column)
    const compareTo = this.compileWallClockOperand(predicate.compareTo, predicate.dateOperands.compareTo)
    return `${column} ${predicate.operator.toUpperCase()} ${compareTo}`
  }

  private compileWallClockOperand(column: string, isDate: boolean): string {
    const wallClock = this.compileAppWallClock(this.compileColumnReference(column))
    return isDate ? `(date(${wallClock}) || ' 00:00:00.000')` : `strftime('%Y-%m-%d %H:%M:%f', ${wallClock})`
  }

  protected override compileComparisonSubject(predicate: QueryPredicate): string {
    const column = this.compileColumnReference(predicate.column)
    return predicate.valueType === 'date' ? `date(${this.compileAppWallClock(column)})` : column
  }

  protected override compileDatePredicate(
    predicate: QueryDatePredicate,
    placeholder: string,
  ): string {
    const reference = this.compileColumnReference(predicate.column)
    if (predicate.part === 'instant') {
      return `julianday(${reference}) ${predicate.operator.toUpperCase()} julianday(${placeholder})`
    }

    const column = this.compileAppWallClock(reference)
    switch (predicate.part) {
      case 'date':
        return `date(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'time':
        return `time(${column}) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'year':
        return `CAST(strftime('%Y', ${column}) AS INTEGER) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'month':
        return `CAST(strftime('%m', ${column}) AS INTEGER) ${predicate.operator.toUpperCase()} ${placeholder}`
      case 'day':
        return `CAST(strftime('%d', ${column}) AS INTEGER) ${predicate.operator.toUpperCase()} ${placeholder}`
      default:
        return super.compileDatePredicate(predicate, placeholder)
    }
  }

  protected override compileInsertPrefix(plan: InsertStatementOptions): string {
    return plan.ignoreConflicts ? 'INSERT OR IGNORE INTO' : 'INSERT INTO'
  }
}
