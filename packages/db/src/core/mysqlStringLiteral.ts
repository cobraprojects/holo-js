export function requiresHexStringLiteral(value: string): boolean {
  return value.includes('\\') || value.includes('\0')
}

export function compileMySQLStringLiteral(value: string): string {
  if (requiresHexStringLiteral(value)) {
    return `_utf8mb4 X'${Buffer.from(value, 'utf8').toString('hex').toUpperCase()}'`
  }

  return `'${value.replaceAll('\'', '\'\'')}'`
}
