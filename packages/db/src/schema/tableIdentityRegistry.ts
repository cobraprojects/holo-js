import { openSchemaChangingTransactions } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { TransactionFrame } from '../core/openTransactions'

export type TableNameFolding = 'none' | 'ascii' | 'lower'

type CanonicalTableNameEntry = {
  readonly generation: number
  readonly identity: string
}

type CanonicalTableNames = Map<string, Map<string, CanonicalTableNameEntry>>

const canonicalNames: CanonicalTableNames = new Map()
const transactionCanonicalNames = new WeakMap<TransactionFrame, CanonicalTableNames>()
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

function namesFor(frame: TransactionFrame | undefined): CanonicalTableNames {
  if (!frame) return canonicalNames
  const existing = transactionCanonicalNames.get(frame)
  if (existing) return existing
  const created: CanonicalTableNames = new Map()
  transactionCanonicalNames.set(frame, created)
  return created
}

function currentEntry(names: CanonicalTableNames | undefined, connectionName: string, tableName: string): CanonicalTableNameEntry | undefined {
  const entry = names?.get(connectionName)?.get(tableName)
  return entry?.generation === currentSchemaGeneration() ? entry : undefined
}

function currentCanonicalEntry(connectionName: string, tableName: string): CanonicalTableNameEntry | undefined {
  for (const frame of openSchemaChangingTransactions()) {
    const entry = currentEntry(transactionCanonicalNames.get(frame), connectionName, tableName)
    if (entry) return entry
  }
  return currentEntry(canonicalNames, connectionName, tableName)
}

export function rememberCanonicalTableName(connectionName: string, tableName: string, identity: string, frame?: TransactionFrame): void {
  const names = namesFor(frame)
  const connectionNames = names.get(connectionName) ?? new Map<string, CanonicalTableNameEntry>()
  connectionNames.set(tableName, { generation: currentSchemaGeneration(), identity })
  names.set(connectionName, connectionNames)
}

export function isTableIdentityResolved(connectionName: string, tableName: string): boolean {
  return currentCanonicalEntry(connectionName, tableName) !== undefined
}

export function lastKnownCanonicalTableName(connectionName: string, tableName: string): string | undefined {
  return canonicalNames.get(connectionName)?.get(tableName)?.identity
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  return currentCanonicalEntry(connectionName, tableName)?.identity ?? foldTableName(connectionName, tableName)
}
