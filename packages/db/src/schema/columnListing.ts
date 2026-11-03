import { createSchemaReader } from './introspection'
import type { DatabaseContext } from '../core/DatabaseContext'

type ColumnListingEntry = {
  readonly load: Promise<ReadonlySet<string>>
  columns?: ReadonlySet<string>
}

const listings = new Map<string, Map<string, ColumnListingEntry>>()

function connectionListings(connectionName: string): Map<string, ColumnListingEntry> {
  const existing = listings.get(connectionName)
  if (existing) {
    return existing
  }

  const created = new Map<string, ColumnListingEntry>()
  listings.set(connectionName, created)
  return created
}

async function readColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const structure = await createSchemaReader(connection).readTableStructure(tableName)
  return new Set(structure?.columns.map(column => column.name) ?? [])
}

export function loadColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const tables = connectionListings(connection.getConnectionName())
  const cached = tables.get(tableName)
  if (cached) {
    return cached.load
  }

  const entry: ColumnListingEntry = {
    load: readColumnListing(connection, tableName).then((columns) => {
      if (columns.size === 0) {
        tables.delete(tableName)
      } else {
        entry.columns = columns
      }
      return columns
    }, (error: unknown) => {
      tables.delete(tableName)
      throw error
    }),
  }
  tables.set(tableName, entry)
  return entry.load
}

export function getLoadedColumnListing(connectionName: string, tableName: string): ReadonlySet<string> | undefined {
  return listings.get(connectionName)?.get(tableName)?.columns
}

export function forgetColumnListings(connectionName: string): void {
  listings.delete(connectionName)
}
