export type SchemaDefaultDialectName = 'sqlite' | 'postgres' | 'mysql'

export function compileDialectStringLiteral(dialect: SchemaDefaultDialectName, value: string): string {
  const backslashesEscaped = dialect === 'mysql' ? value.replaceAll('\\', '\\\\') : value
  return `'${backslashesEscaped.replaceAll('\'', '\'\'')}'`
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
    return `'${value.toISOString()}'`
  }

  if (typeof value === 'object') {
    return compileDialectStringLiteral(dialect, JSON.stringify(value))
  }

  return compileDialectStringLiteral(dialect, String(value))
}
