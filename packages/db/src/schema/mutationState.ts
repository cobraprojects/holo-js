import type { DatabaseContext } from '../core/DatabaseContext'
import type { TableDefinition } from './types'

type SchemaMutation = {
  name: string
  before: TableDefinition | undefined
  after: TableDefinition | undefined
}

type MutationScope = {
  parent: DatabaseContext
  mutations: SchemaMutation[]
}

const scopes = new WeakMap<DatabaseContext, MutationScope>()

export function beginSchemaMutationScope(connection: DatabaseContext, parent: DatabaseContext): void {
  const dialect = connection.getDialect().name
  if (dialect.startsWith('sqlite') || dialect.startsWith('postgres')) {
    scopes.set(connection, { parent, mutations: [] })
  }
}

export function commitSchemaMutationScope(connection: DatabaseContext): void {
  const scope = scopes.get(connection)
  if (!scope) return
  scopes.get(scope.parent)?.mutations.push(...scope.mutations)
  scopes.delete(connection)
}

export function rollbackSchemaMutationScope(connection: DatabaseContext): void {
  const scope = scopes.get(connection)
  if (!scope) return
  const registry = connection.getSchemaRegistry()
  for (const mutation of scope.mutations.reverse()) {
    if (registry.get(mutation.name) !== mutation.after) continue
    if (mutation.before) {
      registry.replace(mutation.before)
    } else {
      registry.delete(mutation.name)
    }
  }
  scopes.delete(connection)
}

export function mutateSchemaRegistry(connection: DatabaseContext, names: readonly string[], mutate: () => void): void {
  const registry = connection.getSchemaRegistry()
  const scope = scopes.get(connection)
  if (!scope) {
    mutate()
    return
  }
  const preceding = names.map(name => registry.get(name))
  mutate()
  for (const [position, name] of names.entries()) {
    const before = preceding[position]
    const after = registry.get(name)
    if (before !== after) scope.mutations.push({ name, before, after })
  }
}
