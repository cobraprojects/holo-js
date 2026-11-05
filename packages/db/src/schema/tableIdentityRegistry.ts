import { currentSchemaGeneration } from '../core/schemaGeneration'

type CanonicalTableNameEntry = {
  readonly generation: number
  readonly identity: string
}

const canonicalNames = new Map<string, Map<string, CanonicalTableNameEntry>>()

export function rememberCanonicalTableName(connectionName: string, tableName: string, identity: string): void {
  const names = canonicalNames.get(connectionName) ?? new Map<string, CanonicalTableNameEntry>()
  names.set(tableName, { generation: currentSchemaGeneration(), identity })
  canonicalNames.set(connectionName, names)
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  const entry = canonicalNames.get(connectionName)?.get(tableName)
  return entry?.generation === currentSchemaGeneration() ? entry.identity : tableName
}
