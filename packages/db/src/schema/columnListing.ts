import { createSchemaReader } from './introspection'
import { getRootDatabaseContext } from '../core/contextOwnership'
import type { DatabaseContext } from '../core/DatabaseContext'

type ColumnListingEntry = {
  readonly load: Promise<ReadonlySet<string>>
  columns?: ReadonlySet<string>
}

const listings = new WeakMap<DatabaseContext, Map<string, ColumnListingEntry>>()

function connectionListings(connection: DatabaseContext): Map<string, ColumnListingEntry> {
  const root = getRootDatabaseContext(connection)
  const existing = listings.get(root)
  if (existing) {
    return existing
  }

  const created = new Map<string, ColumnListingEntry>()
  listings.set(root, created)
  return created
}

async function readColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const structure = await createSchemaReader(connection).readTableStructure(tableName)
  return new Set(structure?.columns.map(column => column.name) ?? [])
}

export function loadColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const tables = connectionListings(connection)
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

export function getLoadedColumnListing(connection: DatabaseContext, tableName: string): ReadonlySet<string> | undefined {
  return listings.get(getRootDatabaseContext(connection))?.get(tableName)?.columns
}

export function forgetColumnListings(connection: DatabaseContext): void {
  listings.delete(getRootDatabaseContext(connection))
}
