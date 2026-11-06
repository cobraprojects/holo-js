import { SchemaError } from '../core/errors'

const IDENTIFIER_SEGMENT_PATTERN = /^[A-Z_]\w*$/i

export function assertValidIdentifierSegment(identifier: string, context: string): void {
  if (!IDENTIFIER_SEGMENT_PATTERN.test(identifier)) {
    throw new SchemaError(`${context} must be a valid SQL identifier segment.`)
  }
}

function assertValidIdentifierPath(identifier: string, context: string): void {
  if (!identifier.trim()) {
    throw new SchemaError(`${context} must not be empty.`)
  }

  const segments = tablePathSegments(identifier)
  if (segments.some(segment => !segment.trim())) {
    throw new SchemaError(`${context} must not contain empty identifier segments.`)
  }

  for (const segment of segments) {
    assertValidIdentifierSegment(segment, context)
  }
}

export function assertValidTablePath(identifier: string, context: string): void {
  assertValidIdentifierPath(identifier, context)
  if (tablePathSegments(identifier).length > 2) {
    throw new SchemaError(`${context} "${identifier}" must be a table name or a schema-qualified table name.`)
  }
}

export interface TablePath {
  readonly schema?: string
  readonly table: string
}

export function splitTablePath(tableName: string): TablePath {
  const separator = tableName.lastIndexOf('.')
  return separator === -1
    ? { table: tableName }
    : { schema: tableName.slice(0, separator), table: tableName.slice(separator + 1) }
}

export interface IdentifierQuoting {
  quoteIdentifier(identifier: string): string
}

export function tablePathSegments(tableName: string): string[] {
  return tableName.split('.')
}

export function quoteTablePath(dialect: IdentifierQuoting, tableName: string): string {
  const { schema, table } = splitTablePath(tableName)
  const quotedTable = dialect.quoteIdentifier(table)
  return schema === undefined ? quotedTable : `${dialect.quoteIdentifier(schema)}.${quotedTable}`
}

export function quoteIdentifierSegment(segment: string, quote: string): string {
  return `${quote}${segment.replaceAll(quote, `${quote}${quote}`)}${quote}`
}

export function sanitizeIdentifierForGeneratedName(identifier: string): string {
  return identifier.replaceAll('.', '_')
}
