import { compileMySQLStringLiteral } from '../core/mysqlStringLiteral'
import { SQLQueryCompiler } from './SQLQueryCompiler'
import { serializeRelationKeys, type QueryRelationKeysPredicate } from './ast'
import { splitTablePath } from '../schema/identifiers'
import type { CompiledStatement } from '../core/types'
import type { TableNameFolding } from '../schema/tableIdentityRegistry'
import { formatWallClockSeconds } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'
import type { DeleteQueryPlan, InsertStatementOptions, QueryFullTextPredicate, QueryJsonPredicate, QueryJsonUpdateOperation, QueryLikePredicate, QueryLockMode, QueryPredicate, UpsertQueryPlan } from './ast'

const MYSQL_DECIMAL_DIGITS = 65

const MYSQL_DECIMAL_KEY_INTEGER_DIGITS = 35

export class MySQLQueryCompiler extends SQLQueryCompiler {
  protected override compileRelationKeys(predicate: QueryRelationKeysPredicate, bindings: unknown[]): string {
    const column = this.compileColumnReference(predicate.column)
    const serialized = serializeRelationKeys(predicate.values)
    bindings.push(serialized)
    const parameter = this.createPlaceholder(bindings.length)
    bindings.push(serialized)
    const value = `JSON_UNQUOTE(JSON_EXTRACT(${parameter}, CONCAT('$[', holo_keys.ordinal - 1, ']')))`
    const key = predicate.valueType === 'blob' ? `UNHEX(${value})` : value
    return `${column} IN (SELECT ${key} FROM JSON_TABLE(${this.createPlaceholder(bindings.length)}, '$[*]' COLUMNS (ordinal FOR ORDINALITY)) AS holo_keys)`
  }

  override compileTableIdentityLookup(tableName: string): CompiledStatement {
    const { schema, table } = splitTablePath(tableName)
    const schemaLiteral = schema === undefined ? 'NULL' : compileMySQLStringLiteral(schema)
    const tableLiteral = compileMySQLStringLiteral(table)
    return {
      sql: `SELECT COALESCE(\`tables\`.\`TABLE_SCHEMA\`, ${schemaLiteral}, DATABASE()) AS \`schema\`, COALESCE(\`tables\`.\`TABLE_NAME\`, ${tableLiteral}) AS \`name\`, DATABASE() AS \`bare_schema\` FROM (SELECT 1) AS \`probe\` LEFT JOIN information_schema.\`TABLES\` AS \`tables\` ON \`tables\`.\`TABLE_SCHEMA\` = COALESCE(${schemaLiteral}, DATABASE()) AND \`tables\`.\`TABLE_NAME\` = ${tableLiteral}`,
      bindings: [],
      source: `schema:introspect:tableIdentity:${tableName}`,
    }
  }

  override compileTableNameFoldingLookup(): CompiledStatement {
    return { sql: 'SELECT @@lower_case_table_names AS `folding`', bindings: [], source: 'schema:introspect:tableNameFolding' }
  }

  override tableNameFolding(lookup?: Readonly<Record<string, unknown>>): TableNameFolding {
    return Number(lookup?.folding ?? 0) === 0 ? 'none' : 'lower'
  }

  protected override compileLikePredicate(predicate: QueryLikePredicate, bindings: unknown[]): string {
    bindings.push(predicate.value)
    const negation = predicate.negated ? 'NOT ' : ''
    const placeholder = this.createPlaceholder(bindings.length)
    if (predicate.caseSensitive) {
      return `${this.compileLikeSubject(predicate)} ${negation}LIKE BINARY ${placeholder}`
    }

    return predicate.path.length === 0
      ? `${this.compileLikeSubject(predicate)} ${negation}LIKE ${placeholder}`
      : `LOWER(${this.compileLikeSubject(predicate)}) ${negation}LIKE LOWER(${placeholder})`
  }

  protected override compileJsonTextExtraction(column: string, path: readonly string[]): string {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${this.createJsonPathLiteral(path)}))`
  }

  protected override compileTextKey(expression: string): string {
    return `CONCAT(${expression}) COLLATE utf8mb4_0900_bin`
  }

  protected override compileIntegerKey(expression: string): string {
    return `CASE WHEN ${expression} REGEXP '^-?(0|[1-9][0-9]{0,18})([.]0+)?$' AND ${expression} NOT REGEXP '[^-.0-9]' THEN CAST(SUBSTRING_INDEX(${expression}, '.', 1) AS DECIMAL(65, 0)) END`
  }

  protected override compileDecimalKey(expression: string): string {
    return `CASE WHEN ${expression} REGEXP '^-?(0|[1-9][0-9]{0,34})([.][0-9]{1,30}0*)?$' AND ${expression} NOT REGEXP '[^-.0-9]' THEN CAST(LEFT(${expression}, LOCATE('.', CONCAT(${expression}, '.')) + 30) AS DECIMAL(65, 30)) END`
  }

  protected override compileDecimalKeyComparison(lookedUp: string, source: string, operator: string): string {
    const valid = `${source} REGEXP '^-?(0|[1-9][0-9]{0,64})([.][0-9]+)?$' AND ${source} NOT REGEXP '[^-.0-9]'`
    const integer = `SUBSTRING_INDEX(${source}, '.', 1)`
    const digits = `LENGTH(TRIM(LEADING '-' FROM ${integer}))`
    const fraction = `IF(LOCATE('.', ${source}) > 0, TRIM(TRAILING '0' FROM SUBSTRING_INDEX(${source}, '.', -1)), '')`
    const whole = `CASE WHEN ${valid} AND ${fraction} = '' THEN CAST(${integer} AS DECIMAL(65, 0)) END`
    const wide = `${valid} AND ${digits} > ${MYSQL_DECIMAL_KEY_INTEGER_DIGITS} AND ${fraction} <> '' AND ${digits} + LENGTH(${fraction}) <= ${MYSQL_DECIMAL_DIGITS}`
    const wideInteger = `CASE WHEN ${wide} THEN CAST(${integer} AS DECIMAL(65, 0)) END`
    const wideFraction = `CAST(CASE WHEN ${wide} THEN CONCAT(IF(LEFT(${source}, 1) = '-', '-', ''), '0.', ${fraction}) END AS DECIMAL(65, 30))`
    const wideMatch = `${lookedUp} > ${wideInteger} - 1 AND ${lookedUp} < ${wideInteger} + 1 AND TRUNCATE(${lookedUp}, 0) = ${wideInteger} AND ${lookedUp} - TRUNCATE(${lookedUp}, 0) = ${wideFraction}`
    return `(${super.compileDecimalKeyComparison(lookedUp, source, operator)} OR ${lookedUp} ${operator} ${whole} OR (${wideMatch}))`
  }

  protected override compileKeyKind(expression: string): string {
    return `CASE JSON_TYPE(JSON_EXTRACT(JSON_ARRAY(${expression}), '$[0]')) WHEN 'INTEGER' THEN 'integer' WHEN 'UNSIGNED INTEGER' THEN 'integer' WHEN 'DECIMAL' THEN 'decimal' WHEN 'STRING' THEN 'text' END`
  }

  protected override createSqlStringLiteral(value: string): string {
    return compileMySQLStringLiteral(value)
  }

  protected override createJsonPathLiteral(path: readonly string[]): string {
    const serializedPath = path.reduce((current, segment) => {
      if (/^[A-Z_]\w*$/i.test(segment)) {
        return `${current}.${segment}`
      }

      return `${current}.${JSON.stringify(segment)}`
    }, '$')

    return this.createSqlStringLiteral(serializedPath)
  }

  protected override compileLateralJoinSource(subquery: string, alias: string): string {
    return `LATERAL ${subquery} ${this.quoteIdentifier(alias)}`
  }

  protected override compileDeleteTarget(source: DeleteQueryPlan['source']): string {
    return source.alias
      ? `DELETE ${this.quoteIdentifier(source.alias)} FROM ${this.compileWriteTarget(source)}`
      : super.compileDeleteTarget(source)
  }

  protected override compileLockClause(lockMode: QueryLockMode): string {
    return lockMode === 'update' ? 'FOR UPDATE' : 'LOCK IN SHARE MODE'
  }

  protected override compileInsertPrefix(plan: InsertStatementOptions): string {
    return plan.ignoreConflicts ? 'INSERT IGNORE INTO' : 'INSERT INTO'
  }

  protected override compileUpsertSuffix(plan: UpsertQueryPlan, insertColumns: readonly string[]): string {
    if (plan.updateColumns.length === 0) {
      const column = this.quoteIdentifier(plan.uniqueBy[0] ?? insertColumns[0]!)
      return ` ON DUPLICATE KEY UPDATE ${column} = ${column}`
    }
    const updates = plan.updateColumns
      .map(column => `${this.quoteIdentifier(column)} = VALUES(${this.quoteIdentifier(column)})`)
      .join(', ')
    return ` ON DUPLICATE KEY UPDATE ${updates}`
  }

  protected override createDateLiteral(value: Date): string {
    return this.createSqlStringLiteral(formatWallClockSeconds(value, getApplicationTimezone()))
  }

  override truncateCommitsOpenTransaction(): boolean {
    return true
  }

  protected override compileTruncateSql(table: string): string {
    return `TRUNCATE TABLE ${table}`
  }

  protected override compileRandomOrder(): string {
    return 'RAND()'
  }

  protected override compileComparisonPlaceholder(predicate: QueryPredicate, index: number): string {
    const placeholder = this.createPlaceholder(index)
    return predicate.valueType === 'json' ? `CAST(${placeholder} AS JSON)` : placeholder
  }

  protected override compileJsonPredicate(
    predicate: QueryJsonPredicate,
    bindings: unknown[],
  ): string {
    const column = this.compileColumnReference(predicate.column)
    const pathLiteral = this.createJsonPathLiteral(predicate.path)
    const extracted = `JSON_EXTRACT(${column}, ${pathLiteral})`

    if (predicate.jsonMode === 'value') {
      if (predicate.value === null) {
        const extractedType = `JSON_TYPE(${extracted})`
        return predicate.operator === '='
          ? `${extractedType} = 'NULL'`
          : `${extractedType} IS NOT NULL AND ${extractedType} != 'NULL'`
      }

      if (predicate.operator === '=' || predicate.operator === '!=') {
        bindings.push(JSON.stringify(predicate.value))
        return `${extracted} ${predicate.operator} CAST(${this.createPlaceholder(bindings.length)} AS JSON)`
      }

      bindings.push(predicate.value)
      return `JSON_UNQUOTE(${extracted}) ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }

    if (predicate.jsonMode === 'key') {
      return `IFNULL(JSON_CONTAINS_PATH(${column}, 'one', ${pathLiteral}), 0)`
    }

    if (predicate.jsonMode === 'contains') {
      bindings.push(JSON.stringify(predicate.value))
      return `COALESCE(JSON_CONTAINS(${extracted}, CAST(${this.createPlaceholder(bindings.length)} AS JSON)), 0)`
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
}
