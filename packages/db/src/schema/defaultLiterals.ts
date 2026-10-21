import { compileMySQLStringLiteral } from '../core/mysqlStringLiteral'
import { formatWallClock, formatWithOffset } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'

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
      : `'${value.toISOString()}'`
  }

  if (typeof value === 'object') {
    return compileDialectStringLiteral(dialect, JSON.stringify(value))
  }

  return compileDialectStringLiteral(dialect, String(value))
}
