const canonicalNames = new Map<string, Map<string, string>>()

export function rememberCanonicalTableName(connectionName: string, tableName: string, identity: string): void {
  const names = canonicalNames.get(connectionName) ?? new Map<string, string>()
  names.set(tableName, identity)
  canonicalNames.set(connectionName, names)
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  return canonicalNames.get(connectionName)?.get(tableName) ?? tableName
}
