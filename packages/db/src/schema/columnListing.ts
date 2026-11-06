import { assertQueryTablePath } from '../query/validator'
import { createSchemaReader } from './introspection'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentRootTransaction } from '../core/openTransactions'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { TableDefinition } from './types'

type SchemaCacheEntry<TValue> = {
  readonly generation: number
  readonly load: Promise<TValue>
  value?: TValue
}

type SchemaCache<TValue> = {
  load(connection: DatabaseContext, tableName: string): Promise<TValue>
  getLoaded(connection: DatabaseContext, tableName: string): TValue | undefined
}

function listingOwner(connection: DatabaseContext): object {
  return currentRootTransaction(connection) ?? getRootDatabaseContext(connection)
}

function createSchemaCache<TValue>(
  read: (connection: DatabaseContext, tableName: string) => Promise<TValue>,
  found: (value: TValue) => boolean,
): SchemaCache<TValue> {
  const owners = new WeakMap<object, Map<string, SchemaCacheEntry<TValue>>>()

  function ownerEntries(connection: DatabaseContext): Map<string, SchemaCacheEntry<TValue>> {
    const owner = listingOwner(connection)
    const existing = owners.get(owner)
    if (existing) {
      return existing
    }

    const created = new Map<string, SchemaCacheEntry<TValue>>()
    owners.set(owner, created)
    return created
  }

  function currentEntry(tables: Map<string, SchemaCacheEntry<TValue>> | undefined, tableName: string): SchemaCacheEntry<TValue> | undefined {
    const entry = tables?.get(tableName)
    return entry?.generation === currentSchemaGeneration() ? entry : undefined
  }

  return {
    load(connection, tableName) {
      assertQueryTablePath(tableName)
      const tables = ownerEntries(connection)
      const cached = currentEntry(tables, tableName)
      if (cached) {
        return cached.load
      }

      const forget = () => {
        if (tables.get(tableName) === entry) {
          tables.delete(tableName)
        }
      }
      const entry: SchemaCacheEntry<TValue> = {
        generation: currentSchemaGeneration(),
        load: read(connection, tableName).then((value) => {
          if (found(value)) {
            entry.value = value
          } else {
            forget()
          }
          return value
        }, (error: unknown) => {
          forget()
          throw error
        }),
      }
      tables.set(tableName, entry)
      return entry.load
    },
    getLoaded(connection, tableName) {
      return currentEntry(owners.get(listingOwner(connection)), tableName)?.value
    },
  }
}

const columnListings = createSchemaCache<ReadonlySet<string>>(async (connection, tableName) => {
  const structure = await createSchemaReader(connection).readTableStructure(tableName)
  return new Set(structure?.columns.map(column => column.name) ?? [])
}, columns => columns.size > 0)

const tableDefinitions = createSchemaCache<TableDefinition | undefined>(
  (connection, tableName) => createSchemaReader(connection).readTable(tableName),
  table => table !== undefined,
)

export function loadColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  return columnListings.load(connection, tableName)
}

export function getLoadedColumnListing(connection: DatabaseContext, tableName: string): ReadonlySet<string> | undefined {
  return columnListings.getLoaded(connection, tableName)
}

export function loadTableDefinition(connection: DatabaseContext, tableName: string): Promise<TableDefinition | undefined> {
  return tableDefinitions.load(connection, tableName)
}

export function getLoadedTableDefinition(connection: DatabaseContext, tableName: string): TableDefinition | undefined {
  return tableDefinitions.getLoaded(connection, tableName)
}
