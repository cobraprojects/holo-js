import { createMigrationService, type MigrationDefinition } from '@holo-js/db'
import type { HoloRuntime } from '@holo-js/core'
import { initializeProjectRuntime } from './runtime'
import { loadRegisteredMigrations } from './project/discovery'
import { loadProjectPluginMigrations } from './project/plugins'
import type { HoloAppCommandMigrationOptions, HoloAppCommandRuntime, LoadedProjectConfig } from './types'

type AppCommandRuntimeSession = {
  readonly api: HoloAppCommandRuntime
  readonly holo: HoloRuntime
  users: number
}

type AppCommandRuntimeDependencies = {
  readonly initialize: (projectRoot: string) => Promise<HoloRuntime>
  readonly loadMigrations: (
    projectRoot: string,
    project: LoadedProjectConfig,
  ) => Promise<readonly MigrationDefinition[]>
}

function migrationName(migration: MigrationDefinition): string {
  if (!migration.name) throw new Error('Application command migrations require resolved names.')
  return migration.name
}

function selectMigrations(
  migrations: readonly MigrationDefinition[],
  requestedNames: readonly string[],
): readonly MigrationDefinition[] {
  if (requestedNames.length === 0) throw new Error('Application command migration names must not be empty.')
  const requested = new Set<string>()
  for (const name of requestedNames) {
    if (!name.trim() || name !== name.trim()) throw new Error('Application command migration names must be non-empty normalized strings.')
    if (requested.has(name)) throw new Error(`Duplicate requested migration name: ${name}.`)
    requested.add(name)
  }

  const available = new Map(migrations.map(migration => [migrationName(migration), migration]))
  return Object.freeze(requestedNames.map((name) => {
    const migration = available.get(name)
    if (!migration) throw new Error(`Unknown application command migration: ${name}.`)
    return migration
  }))
}

async function loadAllMigrations(
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<readonly MigrationDefinition[]> {
  const migrations = [
    ...await loadRegisteredMigrations(projectRoot, project.config),
    ...await loadProjectPluginMigrations(projectRoot),
  ]
  const names = new Set<string>()
  for (const migration of migrations) {
    const name = migrationName(migration)
    if (names.has(name)) throw new Error(`Duplicate migration name: ${name}.`)
    names.add(name)
  }
  return Object.freeze(migrations)
}

export function createAppCommandRuntimeBoundary(
  projectRoot: string,
  loadProject: () => Promise<LoadedProjectConfig>,
  dependencies: AppCommandRuntimeDependencies = {
    initialize: initializeProjectRuntime,
    loadMigrations: loadAllMigrations,
  },
): <TResult>(
  operation: (runtime: HoloAppCommandRuntime) => TResult | Promise<TResult>,
) => Promise<TResult> {
  let active: AppCommandRuntimeSession | undefined
  let pending: Promise<AppCommandRuntimeSession> | undefined
  let closing: Promise<void> | undefined

  const createSession = async (): Promise<AppCommandRuntimeSession> => {
    const project = await loadProject()
    const migrations = await dependencies.loadMigrations(projectRoot, project)
    const holo = await dependencies.initialize(projectRoot)
    const api: HoloAppCommandRuntime = Object.freeze({
      holo,
      async migrate(options: HoloAppCommandMigrationOptions): Promise<readonly string[]> {
        const selected = selectMigrations(migrations, options.names)
        const migrator = createMigrationService(holo.manager.connection(), selected)
        const pendingNames = (await migrator.status())
          .filter(status => status.status === 'pending')
          .map(status => status.name)
        if (options.pretend) return Object.freeze(pendingNames)
        return Object.freeze((await migrator.migrate()).map(migrationName))
      },
    })
    return { api, holo, users: 0 }
  }

  return async <TResult>(
    operation: (runtime: HoloAppCommandRuntime) => TResult | Promise<TResult>,
  ): Promise<TResult> => {
    if (closing) await closing
    pending ??= createSession()
    let session: AppCommandRuntimeSession
    try {
      session = active ?? await pending
    } catch (error) {
      pending = undefined
      throw error
    }
    active ??= session
    session.users += 1
    try {
      return await operation(session.api)
    } finally {
      session.users -= 1
      if (session.users === 0 && active === session) {
        active = undefined
        pending = undefined
        const shutdown = session.holo.shutdown()
        closing = shutdown
        try {
          await shutdown
        } finally {
          if (closing === shutdown) closing = undefined
        }
      }
    }
  }
}
