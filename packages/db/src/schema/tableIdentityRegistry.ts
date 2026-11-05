import { currentSchemaGeneration } from '../core/schemaGeneration'
import { splitTablePath } from './identifiers'

export type TableNameFolding = 'none' | 'ascii' | 'lower'

type CanonicalTableNameEntry = {
  readonly generation: number
  readonly identity: string
}

const canonicalNames = new Map<string, Map<string, CanonicalTableNameEntry>>()
const foldings = new Map<string, TableNameFolding>()

export function rememberTableNameFolding(connectionName: string, folding: TableNameFolding): void {
  foldings.set(connectionName, folding)
}

export function foldTableName(connectionName: string, tableName: string): string {
  switch (foldings.get(connectionName)) {
    case 'ascii':
      return tableName.replace(/[A-Z]/g, letter => letter.toLowerCase())
    case 'lower':
      return tableName.toLowerCase()
    default:
      return tableName
  }
}

export function rememberCanonicalTableName(connectionName: string, tableName: string, identity: string): void {
  const names = canonicalNames.get(connectionName) ?? new Map<string, CanonicalTableNameEntry>()
  names.set(tableName, { generation: currentSchemaGeneration(), identity })
  canonicalNames.set(connectionName, names)
}

export function isTableIdentityResolved(connectionName: string, tableName: string): boolean {
  if (splitTablePath(tableName).schema === undefined) return foldings.has(connectionName)
  return canonicalNames.get(connectionName)?.get(tableName)?.generation === currentSchemaGeneration()
}

export function lastKnownCanonicalTableName(connectionName: string, tableName: string): string | undefined {
  if (splitTablePath(tableName).schema === undefined) return foldings.has(connectionName) ? foldTableName(connectionName, tableName) : undefined
  return canonicalNames.get(connectionName)?.get(tableName)?.identity
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  const entry = canonicalNames.get(connectionName)?.get(tableName)
  return entry?.generation === currentSchemaGeneration() ? entry.identity : foldTableName(connectionName, tableName)
}
