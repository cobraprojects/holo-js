import { openSchemaChangingTransactions } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { TransactionFrame } from '../core/openTransactions'

type CanonicalTableNameEntry = {
  readonly generation: number
  readonly identity: string
}

type CanonicalTableNames = Map<string, Map<string, CanonicalTableNameEntry>>

const canonicalNames: CanonicalTableNames = new Map()
const transactionCanonicalNames = new WeakMap<TransactionFrame, CanonicalTableNames>()

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

export function rememberCanonicalTableName(connectionName: string, tableName: string, identity: string, frame?: TransactionFrame): void {
  const names = namesFor(frame)
  const connectionNames = names.get(connectionName) ?? new Map<string, CanonicalTableNameEntry>()
  connectionNames.set(tableName, { generation: currentSchemaGeneration(), identity })
  names.set(connectionName, connectionNames)
}

export function canonicalTableName(connectionName: string, tableName: string): string {
  for (const frame of openSchemaChangingTransactions()) {
    const entry = currentEntry(transactionCanonicalNames.get(frame), connectionName, tableName)
    if (entry) return entry.identity
  }
  return currentEntry(canonicalNames, connectionName, tableName)?.identity ?? tableName
}
