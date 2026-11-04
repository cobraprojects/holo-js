import { compileMySQLStringLiteral } from '../core/mysqlStringLiteral'
import { formatWallClock, formatWithOffset } from '../applicationTime'
import { formatSQLiteDateTime } from '../sqliteDateTime'
import { getApplicationTimezone } from '../applicationTimezone'
import { SchemaError } from '../core/errors'
import type { LogicalColumnKind } from './types'

export type SchemaDefaultDialectName = 'sqlite' | 'postgres' | 'mysql'

function compileDialectStringLiteral(dialect: SchemaDefaultDialectName, value: string): string {
  if (dialect === 'mysql') {
    return compileMySQLStringLiteral(value)
  }

  return `'${value.replaceAll('\'', '\'\'')}'`
}

function compileBooleanLiteral(dialect: SchemaDefaultDialectName, value: boolean): string {
  if (dialect === 'postgres') {
    return value ? 'TRUE' : 'FALSE'
  }

  return value ? '1' : '0'
}

export function compileDialectDefaultLiteral(
  dialect: SchemaDefaultDialectName,
  value: unknown,
): string {
  if (typeof value === 'boolean') {
    return compileBooleanLiteral(dialect, value)
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (value === null) {
    return 'NULL'
  }

  if (value instanceof Date) {
    if (dialect === 'mysql') {
      return `'${formatWallClock(value, getApplicationTimezone())}'`
    }

    return dialect === 'postgres'
      ? `'${formatWithOffset(value, getApplicationTimezone())}'`
      : `'${formatSQLiteDateTime(value)}'`
  }

  if (typeof value === 'object') {
    return compileDialectStringLiteral(dialect, JSON.stringify(value))
  }

  return compileDialectStringLiteral(dialect, String(value))
}

export function compileColumnDefaultLiteral(
  dialect: SchemaDefaultDialectName,
  value: unknown,
  kind: LogicalColumnKind,
): string {
  if (kind !== 'json' || value === null) {
    return compileDialectDefaultLiteral(dialect, value)
  }

  return compileDialectStringLiteral(dialect, typeof value === 'string' ? value : JSON.stringify(value))
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

export function assertJsonDefaultText(columnName: string, kind: LogicalColumnKind, value: unknown): void {
  if (kind === 'json' && typeof value === 'string' && !isJsonText(value)) {
    throw new SchemaError(
      `Column "${columnName}" has a json default that is not JSON text. Pass JSON text, such as JSON.stringify('hello'), or a value.`,
    )
  }
}
