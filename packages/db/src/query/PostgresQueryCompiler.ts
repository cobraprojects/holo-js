import { SQLQueryCompiler } from './SQLQueryCompiler'
import type { DateBucketStorage } from './dateBuckets'
import type { CompiledStatement } from '../core/types'
import { getApplicationTimezone } from '../applicationTimezone'
import type {
  InsertStatementOptions,
  QueryDateBucketSelection,
  QueryDatePredicate,
  QueryFullTextPredicate,
  QueryJsonPredicate,
  QueryLikePredicate,
  QueryJsonUpdateOperation,
  QueryKeyKind,
  QueryLockMode,
  UpsertQueryPlan,
} from './ast'

const POSTGRES_NUMERIC_INTEGER_DIGITS = 131072

const POSTGRES_DATE_BUCKET_FORMATS: Readonly<Record<QueryDateBucketSelection['unit'], string>> = {
  year: 'YYYY',
  month: 'YYYY-MM',
  day: 'YYYY-MM-DD',
  hour: 'YYYY-MM-DD HH24:00',
}

const POSTGRES_NUMERIC_FRACTION_DIGITS = 16383

export class PostgresQueryCompiler extends SQLQueryCompiler {
  protected override compileIntegerKey(expression: string): string {
    return `CASE WHEN ${expression} ~ '^-?(0|[1-9][0-9]{0,18})([.]0+)?$' THEN CAST(split_part(${expression}, '.', 1) AS NUMERIC) END`
  }

  protected override compileDecimalKey(expression: string): string {
    return `CASE WHEN ${expression} ~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$' AND length(split_part(${expression}, '.', 1)) <= ${POSTGRES_NUMERIC_INTEGER_DIGITS + 1} AND length(split_part(${expression}, '.', 2)) <= ${POSTGRES_NUMERIC_FRACTION_DIGITS} THEN CAST(${expression} AS NUMERIC) END`
  }

  protected override compileKeyKind(expression: string): string {
    const type = `pg_typeof(${expression})`
    return `CASE WHEN ${type} IN ('smallint'::regtype, 'integer'::regtype, 'bigint'::regtype) THEN 'integer' WHEN ${type} = 'numeric'::regtype THEN 'decimal' WHEN ${type} IN ('text'::regtype, 'character varying'::regtype, 'character'::regtype) THEN 'text' END`
  }

  protected override compileKeyOfKind(expression: string, kind: QueryKeyKind): string {
    return kind === 'text' ? `CAST(${expression} AS TEXT)` : `CAST(CAST(${expression} AS TEXT) AS NUMERIC)`
  }

  protected override compileUnknownKindFallback(left: string, right: string, operator: string): string {
    return `CAST(${left} AS TEXT) ${operator} CAST(${right} AS TEXT)`
  }

  protected override createBooleanLiteral(value: boolean): string {
    return value ? 'true' : 'false'
  }

  protected override createBinaryLiteral(value: Uint8Array): string {
    return `'\\x${Buffer.from(value).toString('hex')}'::bytea`
  }

  override compileTableIdentityLookup(tableName: string): CompiledStatement {
    return {
      sql: 'SELECT "namespaces"."nspname" AS "schema", "classes"."relname" AS "name", (SELECT "bare_namespaces"."nspname" FROM pg_catalog.pg_class AS "bare_classes" JOIN pg_catalog.pg_namespace AS "bare_namespaces" ON "bare_namespaces"."oid" = "bare_classes"."relnamespace" WHERE "bare_classes"."oid" = to_regclass(quote_ident("classes"."relname"))) AS "bare_schema" FROM (SELECT 1) AS "probe" LEFT JOIN pg_catalog.pg_class AS "classes" ON "classes"."oid" = to_regclass($1) LEFT JOIN pg_catalog.pg_namespace AS "namespaces" ON "namespaces"."oid" = "classes"."relnamespace"',
      bindings: [this.compileTableReference(tableName)],
      source: `schema:introspect:tableIdentity:${tableName}`,
    }
  }

  protected override compileTruncateSql(table: string): string {
    return `TRUNCATE ${table} RESTART IDENTITY`
  }

  protected override compileLikePredicate(predicate: QueryLikePredicate, bindings: unknown[]): string {
    bindings.push(predicate.value)
    const operator = predicate.caseSensitive ? 'LIKE' : 'ILIKE'
    const subject = predicate.path.length === 0 ? this.compileLikeSubject(predicate) : `(${this.compileLikeSubject(predicate)})`
    return `${subject}::text ${predicate.negated ? 'NOT ' : ''}${operator} ${this.createPlaceholder(bindings.length)}`
  }

  protected override compileJsonTextExtraction(column: string, path: readonly string[]): string {
    return `(${column})::jsonb #>> ${this.createPostgresPathLiteral(path)}`
  }

  protected override compileLateralJoinSource(subquery: string, alias: string): string {
    return `LATERAL ${subquery} AS ${this.quoteIdentifier(alias)}`
  }

  protected override compileLockClause(lockMode: QueryLockMode, lockOf?: string): string {
    const clause = lockMode === 'update' ? 'FOR UPDATE' : 'FOR SHARE'
    return lockOf === undefined ? clause : `${clause} OF ${lockOf}`
  }

  protected override compileInsertSuffix(plan: InsertStatementOptions): string {
    if (plan.returning === true) {
      return `${plan.ignoreConflicts ? ' ON CONFLICT DO NOTHING' : ''} RETURNING *`
    }

    const returning = plan.returningColumn ? ` RETURNING ${this.quoteIdentifier(plan.returningColumn)}` : ''
    return `${plan.ignoreConflicts ? ' ON CONFLICT DO NOTHING' : ''}${returning}`
  }

  protected override compileUpsertSuffix(plan: UpsertQueryPlan, insertColumns: readonly string[]): string {
    const suffix = super.compileUpsertSuffix(plan, insertColumns)
    if (plan.returning === true) {
      return suffix
    }

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
      if (predicate.value === null) {
        const extractedType = `jsonb_typeof(${extractedJson})`
        return predicate.operator === '='
          ? `${extractedType} = 'null'`
          : `${extractedType} IS NOT NULL AND ${extractedType} != 'null'`
      }

      if (predicate.operator === '=' || predicate.operator === '!=') {
        bindings.push(JSON.stringify(predicate.value))
        return `${extractedJson} ${predicate.operator} ${this.createPlaceholder(bindings.length)}::jsonb`
      }

      bindings.push(predicate.value)
      return `${extractedText} ${predicate.operator!.toUpperCase()} ${this.createPlaceholder(bindings.length)}`
    }

    if (predicate.jsonMode === 'key') {
      return `${extractedJson} IS NOT NULL`
    }

    if (predicate.jsonMode === 'contains') {
      bindings.push(JSON.stringify(predicate.value))
      return `COALESCE(${extractedJson} @> ${this.createPlaceholder(bindings.length)}::jsonb, FALSE)`
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

  protected override compileDateBucket(bucket: QueryDateBucketSelection, storage: DateBucketStorage): string {
    const column = this.compileColumnReference(bucket.column)
    const applicationTimeZone = getApplicationTimezone()
    const timeZone = this.createSqlStringLiteral(bucket.timeZone ?? applicationTimeZone)
    const instant = `CASE WHEN pg_typeof(${column}) = 'timestamp with time zone'::regtype THEN CAST(${column} AS TIMESTAMPTZ) ELSE CAST(${column} AS TIMESTAMP) AT TIME ZONE ${this.createSqlStringLiteral(applicationTimeZone)} END`
    const format = POSTGRES_DATE_BUCKET_FORMATS[bucket.unit]
    if (storage === 'calendar') {
      return `CASE WHEN ${column} BETWEEN DATE '0001-01-01' AND DATE '9999-12-31' THEN to_char(CAST(${column} AS TIMESTAMP), '${format}') END`
    }
    const wallClock = `((${instant}) AT TIME ZONE ${timeZone})`
    const formatted = `CASE WHEN ${wallClock} BETWEEN TIMESTAMP '0001-01-01 00:00:00' AND TIMESTAMP '9999-12-31 23:59:59.999999' THEN to_char(${wallClock}, '${format}') END`
    const convertible = `CASE WHEN pg_typeof(${column}) = 'timestamp with time zone'::regtype THEN CAST(${column} AS TIMESTAMPTZ) BETWEEN TIMESTAMPTZ '0001-12-30 00:00:00+00 BC' AND TIMESTAMPTZ '10000-01-02 00:00:00+00' ELSE CAST(${column} AS TIMESTAMP) BETWEEN TIMESTAMP '0001-12-30 00:00:00 BC' AND TIMESTAMP '10000-01-02 00:00:00' END`
    return `CASE WHEN ${convertible} THEN ${formatted} END`
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
