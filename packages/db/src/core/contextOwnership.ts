import type { DatabaseContext } from './DatabaseContext'

const roots = new WeakMap<DatabaseContext, DatabaseContext>()

export function registerDatabaseContext(connection: DatabaseContext, root: DatabaseContext): void {
  roots.set(connection, root)
}

export function getRootDatabaseContext(connection: DatabaseContext): DatabaseContext {
  return roots.get(connection) ?? connection
}
