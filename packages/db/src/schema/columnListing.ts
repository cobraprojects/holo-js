import { createSchemaReader } from './introspection'
import { getRootDatabaseContext } from '../core/contextOwnership'
import { currentSchemaGeneration } from '../core/schemaGeneration'
import type { DatabaseContext } from '../core/DatabaseContext'

type ColumnListingEntry = {
  readonly generation: number
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

function currentEntry(tables: Map<string, ColumnListingEntry> | undefined, tableName: string): ColumnListingEntry | undefined {
  const entry = tables?.get(tableName)
  return entry?.generation === currentSchemaGeneration() ? entry : undefined
}

async function readColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const structure = await createSchemaReader(connection).readTableStructure(tableName)
  return new Set(structure?.columns.map(column => column.name) ?? [])
}

export function loadColumnListing(connection: DatabaseContext, tableName: string): Promise<ReadonlySet<string>> {
  const tables = connectionListings(connection)
  const cached = currentEntry(tables, tableName)
  if (cached) {
    return cached.load
  }

  const forget = () => {
    if (tables.get(tableName) === entry) {
      tables.delete(tableName)
    }
  }
  const entry: ColumnListingEntry = {
    generation: currentSchemaGeneration(),
    load: readColumnListing(connection, tableName).then((columns) => {
      if (columns.size === 0) {
        forget()
      } else {
        entry.columns = columns
      }
      return columns
    }, (error: unknown) => {
      forget()
      throw error
    }),
  }
  tables.set(tableName, entry)
  return entry.load
}

export function getLoadedColumnListing(connection: DatabaseContext, tableName: string): ReadonlySet<string> | undefined {
  return currentEntry(listings.get(getRootDatabaseContext(connection)), tableName)?.columns
}
