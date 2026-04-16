import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { loadConfigDirectory } from '@holo-js/config'
import {
  normalizeHoloProjectConfig,
  type MigrationDefinition,
  type NormalizedHoloProjectConfig,
  type SeederDefinition,
} from '@holo-js/db'
import type { HoloAppCommand } from '../types'
import { loadGeneratedProjectRegistry, writeGeneratedProjectRegistry } from './registry'
import {
  loadBroadcastDiscoveryModule,
  importProjectModule,
  loadEventsDiscoveryModule,
  loadQueueDiscoveryModule,
  readTextFile,
} from './runtime'
import {
  COMMAND_FILE_PATTERN,
  MIGRATION_NAME_PATTERN,
  type CliModelReference,
  type DiscoveredAppCommand,
  type GeneratedCommandRegistryEntry,
  type GeneratedBroadcastRegistryEntry,
  type GeneratedChannelRegistryEntry,
  type GeneratedEventRegistryEntry,
  type GeneratedJobRegistryEntry,
  type GeneratedListenerRegistryEntry,
  type GeneratedMigrationRegistryEntry,
  type GeneratedModelRegistryEntry,
  type GeneratedProjectRegistry,
  type GeneratedSeederRegistryEntry,
  type InactiveGeneratedModelModule,
  type MinimalListenerDefinition,
  type NormalizedDiscoveredQueueJob,
  hasEventDefinitionMarker,
  hasListenerDefinitionMarker,
  isRecord,
  makeProjectRelativePath,
  pathExists,
  toPosixPath,
} from './shared'

async function collectFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const target = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(target))
      continue
    }

    if (entry.isFile() && COMMAND_FILE_PATTERN.test(entry.name)) {
      files.push(target)
    }
  }

  return files
}

function deriveCommandNameFromPath(commandsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(commandsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join(':')
}

function deriveJobNameFromPath(jobsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(jobsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join('.')
}

function deriveEventNameFromPath(eventsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(eventsRoot, sourcePath)).replace(COMMAND_FILE_PATTERN, '')
  const derived = relativePath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived event names require a non-empty source path.')
  }

  return derived
}

function deriveListenerIdFromPath(listenersRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(listenersRoot, sourcePath))
  const derived = relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived listener identifiers require a non-empty source path.')
  }

  return derived
}

function deriveBroadcastNameFromPath(root: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(root, sourcePath)).replace(COMMAND_FILE_PATTERN, '')
  const derived = relativePath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  /* v8 ignore next 3 -- discovered file paths always produce a non-empty derived broadcast name */
  if (!derived) {
    throw new Error('[Holo Broadcast] Derived broadcast names require a non-empty source path.')
  }

  return derived
}

function deriveChannelPatternFromPath(root: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(root, sourcePath)).replace(COMMAND_FILE_PATTERN, '')
  const derived = relativePath
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  /* v8 ignore next 3 -- discovered file paths always produce a non-empty derived channel pattern */
  if (!derived) {
    throw new Error('[Holo Broadcast] Derived channel patterns require a non-empty source path.')
  }

  return derived
}

function resolveDiscoveredJobMetadata(
  job: NormalizedDiscoveredQueueJob,
  sourcePath: string,
  derivedName: string,
  queueConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['queue'],
): GeneratedJobRegistryEntry {
  const connection = job.connection ?? queueConfig.default

  let queue = job.queue
  if (!queue) {
    const configuredConnection = queueConfig.connections[connection]
    queue = configuredConnection ? configuredConnection.queue : 'default'
  }

  return {
    sourcePath,
    name: derivedName,
    connection,
    queue,
    ...(typeof job.tries === 'number' ? { tries: job.tries } : {}),
    ...(typeof job.backoff !== 'undefined' ? { backoff: job.backoff } : {}),
    ...(typeof job.timeout === 'number' ? { timeout: job.timeout } : {}),
  }
}

function isAppCommand(value: unknown): value is HoloAppCommand {
  return isRecord(value)
    && typeof value.description === 'string'
    && typeof value.run === 'function'
}

function resolveCommandExport(moduleValue: unknown): HoloAppCommand | undefined {
  if (isRecord(moduleValue) && isAppCommand(moduleValue.default)) {
    return moduleValue.default
  }

  if (isRecord(moduleValue)) {
    for (const value of Object.values(moduleValue)) {
      if (isAppCommand(value)) {
        return value
      }
    }
  }

  return undefined
}

function normalizeCommandAliases(value: readonly string[] | undefined): readonly string[] | undefined {
  if (!value) {
    return undefined
  }

  const normalized = [...new Set(value.map(alias => alias.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

function assertUniqueEntries(
  kind: 'model' | 'migration' | 'seeder' | 'command' | 'job' | 'event' | 'listener' | 'broadcast' | 'channel',
  entries: readonly { name: string, sourcePath: string }[],
): void {
  const seen = new Map<string, string>()

  for (const entry of entries) {
    const existing = seen.get(entry.name)
    if (existing) {
      throw new Error(`Discovered duplicate ${kind} "${entry.name}" in "${existing}" and "${entry.sourcePath}".`)
    }

    seen.set(entry.name, entry.sourcePath)
  }
}

function assertUniqueCommandTokens(entries: readonly GeneratedCommandRegistryEntry[]): void {
  const seen = new Map<string, string>()

  for (const entry of entries) {
    for (const token of [entry.name, ...entry.aliases]) {
      const existing = seen.get(token)
      if (existing) {
        throw new Error(`Discovered duplicate command token "${token}" in "${existing}" and "${entry.sourcePath}".`)
      }

      seen.set(token, entry.sourcePath)
    }
  }
}

function resolveRegisteredPath(projectRoot: string, entry: string): string {
  return resolve(projectRoot, entry)
}

function resolveNamedExport<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): TValue | undefined {
  if (!isRecord(moduleValue)) return undefined

  if (matcher(moduleValue.default)) return moduleValue.default

  for (const value of Object.values(moduleValue)) {
    if (matcher(value)) return value
  }

  return undefined
}

function resolveNamedExportEntry<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): { exportName: string, value: TValue } | undefined {
  if (!isRecord(moduleValue)) return undefined

  if (matcher(moduleValue.default)) {
    return { exportName: 'default', value: moduleValue.default }
  }

  for (const [exportName, value] of Object.entries(moduleValue)) {
    if (matcher(value)) return { exportName, value }
  }

  return undefined
}

function isCliModelReference(value: unknown): value is CliModelReference {
  return isRecord(value)
    && isRecord(value.definition)
    && value.definition.kind === 'model'
    && typeof value.definition.name === 'string'
    && typeof value.prune === 'function'
}

function isMissingGeneratedSchemaModelError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('is not present in the generated schema registry')
}

function isInactiveGeneratedModelModule(value: unknown): value is InactiveGeneratedModelModule {
  return isRecord(value) && value.holoModelPendingSchema === true
}

function isMigrationDefinition(value: unknown): value is MigrationDefinition {
  return isRecord(value)
    && typeof value.up === 'function'
}

function isSeederDefinition(value: unknown): value is SeederDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.run === 'function'
}

function resolveListenerEventNamesForDiscovery(
  listener: MinimalListenerDefinition,
  eventNamesByReference: ReadonlyMap<object, string> = new Map(),
): readonly string[] {
  return Object.freeze([...new Set(listener.listensTo.map((reference: string | { name?: string }) => {
    if (typeof reference === 'string') {
      return reference.trim()
    }

    if (typeof reference.name === 'string' && reference.name.trim()) {
      return reference.name.trim()
    }

    if (eventNamesByReference.has(reference as object)) {
      return eventNamesByReference.get(reference as object)!
    }

    throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
  }))])
}

function collectImportedBindingsBySource(sourceText: string): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>()
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g

  for (const match of sourceText.matchAll(importPattern)) {
    const clause = match[1]?.trim()
    const source = match[2]?.trim()
    if (!clause || !source) {
      continue
    }

    const namedMatch = clause.match(/\{([\s\S]+)\}/)
    const defaultClause = clause.replace(/\{[\s\S]+\}/, '').replace(/,$/, '').trim()

    if (defaultClause && defaultClause !== '*') {
      bindings.set(defaultClause, source)
    }

    if (namedMatch?.[1]) {
      for (const specifier of namedMatch[1].split(',')) {
        const trimmed = specifier.trim()
        if (!trimmed) {
          continue
        }

        const [imported, local] = trimmed.split(/\s+as\s+/)
        const bindingName = (local ?? imported)?.trim()
        if (bindingName) {
          bindings.set(bindingName, source)
        }
      }
    }
  }

  return bindings
}

function extractListensToItems(sourceText: string): readonly string[] {
  const markerIndex = sourceText.indexOf('listensTo')
  if (markerIndex < 0) {
    return []
  }

  const colonIndex = sourceText.indexOf(':', markerIndex)
  if (colonIndex < 0) {
    return []
  }

  let cursor = colonIndex + 1
  while (cursor < sourceText.length && /\s/.test(sourceText[cursor]!)) {
    cursor += 1
  }

  const startChar = sourceText[cursor]
  let depth = 0
  let inString: '"' | '\'' | '`' | undefined
  let expression = ''

  for (; cursor < sourceText.length; cursor += 1) {
    const char = sourceText[cursor]!
    expression += char

    if (inString) {
      if (char === inString && sourceText[cursor - 1] !== '\\') {
        inString = undefined
      }
      continue
    }

    if (char === '\'' || char === '"' || char === '`') {
      inString = char
      continue
    }

    if (char === '[' || char === '{' || char === '(') {
      depth += 1
      continue
    }

    if (char === ']' || char === '}' || char === ')') {
      depth -= 1
      if (depth === 0 && startChar === '[') {
        break
      }
      continue
    }

    if (depth === 0 && startChar !== '[' && (char === ',' || char === '\n' || char === '\r')) {
      expression = expression.slice(0, -1)
      break
    }
  }

  if (startChar !== '[') {
    const item = expression.trim().replace(/\s+as\s+const$/, '')
    return item ? [item] : []
  }

  return expression
    .slice(1, -1)
    .split(',')
    .map(item => item.trim().replace(/\s+as\s+const$/, ''))
    .filter(Boolean)
}

async function resolveListenerEventNamesFromSource(
  projectRoot: string,
  listenerPath: string,
  discoveredEventNamesBySourcePath: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  const sourceText = await readTextFile(listenerPath) ?? ''
  const bindingsByName = collectImportedBindingsBySource(sourceText)
  const discoveredEventNamesByExtensionlessSourcePath = new Map<string, string>(
    [...discoveredEventNamesBySourcePath.entries()].map(([sourcePath, eventName]) => {
      return [sourcePath.replace(/\.[^.]+$/, ''), eventName]
    }),
  )
  const resolvedEventNames: string[] = []

  for (const item of extractListensToItems(sourceText)) {
    const quoted = item.match(/^['"](.+)['"]$/)
    if (quoted) {
      resolvedEventNames.push(quoted[1]!.trim())
      continue
    }

    const importSource = bindingsByName.get(item)
    if (!importSource) {
      throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
    }

    const importedPath = makeProjectRelativePath(projectRoot, resolve(dirname(listenerPath), importSource))
    const eventName = discoveredEventNamesBySourcePath.get(importedPath)
      ?? discoveredEventNamesByExtensionlessSourcePath.get(importedPath.replace(/\.[^.]+$/, ''))
    if (!eventName) {
      throw new Error('[Holo Events] Listener event references must resolve to explicit event names before discovery registration.')
    }

    resolvedEventNames.push(eventName)
  }

  return Object.freeze([...new Set(resolvedEventNames)])
}

export async function prepareProjectDiscovery(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
): Promise<GeneratedProjectRegistry> {
  const loadedConfig = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  })
  const modelsRoot = resolve(projectRoot, config.paths.models)
  const migrationsRoot = resolve(projectRoot, config.paths.migrations)
  const seedersRoot = resolve(projectRoot, config.paths.seeders)
  const commandsRoot = resolve(projectRoot, config.paths.commands)
  const jobsRoot = resolve(projectRoot, config.paths.jobs)
  const eventsRoot = resolve(projectRoot, config.paths.events)
  const listenersRoot = resolve(projectRoot, config.paths.listeners)
  const broadcastRoot = resolve(projectRoot, 'server/broadcast')
  const channelsRoot = resolve(projectRoot, 'server/channels')

  const [modelFiles, migrationFiles, seederFiles, commandFiles, jobFiles, eventFiles, listenerFiles, broadcastFiles, channelFiles] = await Promise.all([
    collectFiles(modelsRoot),
    collectFiles(migrationsRoot),
    collectFiles(seedersRoot),
    collectFiles(commandsRoot),
    collectFiles(jobsRoot),
    collectFiles(eventsRoot),
    collectFiles(listenersRoot),
    collectFiles(broadcastRoot),
    collectFiles(channelsRoot),
  ])

  const models: GeneratedModelRegistryEntry[] = []
  for (const filePath of modelFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    try {
      const moduleValue = await importProjectModule(projectRoot, filePath)
      const model = resolveNamedExport(moduleValue, isCliModelReference)
      if (!model) {
        if (isInactiveGeneratedModelModule(moduleValue)) {
          continue
        }

        throw new Error(`Discovered model "${relativePath}" does not export a Holo model.`)
      }

      models.push({
        sourcePath: relativePath,
        name: model.definition.name,
        prunable: Boolean(model.definition.prunable),
      })
    } catch (error) {
      if (!isMissingGeneratedSchemaModelError(error)) {
        throw error
      }
    }
  }
  assertUniqueEntries('model', models)

  const migrations: GeneratedMigrationRegistryEntry[] = []
  for (const filePath of migrationFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const migration = resolveNamedExport(moduleValue, isMigrationDefinition)
    if (!migration) {
      throw new Error(`Discovered migration "${relativePath}" does not export a Holo migration.`)
    }

    migrations.push({
      sourcePath: relativePath,
      name: migration.name ? validateMigrationName(migration.name) : inferMigrationNameFromEntry(relativePath),
    })
  }
  assertUniqueEntries('migration', migrations)

  const seeders: GeneratedSeederRegistryEntry[] = []
  for (const filePath of seederFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const seeder = resolveNamedExport(moduleValue, isSeederDefinition)
    if (!seeder) {
      throw new Error(`Discovered seeder "${relativePath}" does not export a Holo seeder.`)
    }

    seeders.push({
      sourcePath: relativePath,
      name: seeder.name,
    })
  }
  assertUniqueEntries('seeder', seeders)

  const commands: GeneratedCommandRegistryEntry[] = []
  for (const filePath of commandFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const command = resolveCommandExport(moduleValue)
    if (!command) {
      throw new Error(`Discovered command "${relativePath}" does not export a Holo command.`)
    }

    const aliases = normalizeCommandAliases(command.aliases) ?? []
    commands.push({
      sourcePath: relativePath,
      name: command.name?.trim() || deriveCommandNameFromPath(commandsRoot, filePath),
      aliases,
      description: command.description,
      ...(command.usage ? { usage: command.usage } : {}),
    })
  }
  assertUniqueEntries('command', commands)
  assertUniqueCommandTokens(commands)

  const jobs: GeneratedJobRegistryEntry[] = []
  const queueDiscovery = jobFiles.length > 0
    ? await loadQueueDiscoveryModule(projectRoot)
    : undefined
  for (const filePath of jobFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await importProjectModule(projectRoot, filePath)
    const exportedJob = resolveNamedExportEntry(
      moduleValue,
      (value): value is unknown => queueDiscovery!.isQueueJobDefinition(value),
    )
    if (!exportedJob) {
      throw new Error(`Discovered job "${relativePath}" does not export a Holo job.`)
    }

    const normalizedJob = queueDiscovery!.normalizeQueueJobDefinition(exportedJob.value)
    jobs.push({
      ...resolveDiscoveredJobMetadata(
        normalizedJob,
        relativePath,
        deriveJobNameFromPath(jobsRoot, filePath),
        loadedConfig.queue,
      ),
      exportName: exportedJob.exportName,
    })
  }
  assertUniqueEntries('job', jobs)

  const events: GeneratedEventRegistryEntry[] = []
  const eventsDiscovery = (eventFiles.length > 0 || listenerFiles.length > 0)
    ? await loadEventsDiscoveryModule(projectRoot)
    : undefined
  const eventNamesByReference = new Map<object, string>()
  const discoveredEventNamesBySourcePath = new Map<string, string>()
  for (const filePath of eventFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedEvent = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => hasEventDefinitionMarker(value),
    )
    if (!exportedEvent || !eventsDiscovery!.isEventDefinition(exportedEvent.value)) {
      throw new Error(`Discovered event "${relativePath}" does not export a Holo event.`)
    }

    const normalizedEvent = eventsDiscovery!.normalizeEventDefinition(exportedEvent.value)
    const name = normalizedEvent.name?.trim() || deriveEventNameFromPath(eventsRoot, filePath)
    eventNamesByReference.set(exportedEvent.value, name)
    discoveredEventNamesBySourcePath.set(relativePath, name)
    events.push({
      sourcePath: relativePath,
      name,
      exportName: exportedEvent.exportName,
    })
  }
  assertUniqueEntries('event', events)
  const discoveredEventNames = new Set(events.map(entry => entry.name))

  const listeners: GeneratedListenerRegistryEntry[] = []
  for (const filePath of listenerFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedListener = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => hasListenerDefinitionMarker(value),
    )
    if (!exportedListener || !eventsDiscovery!.isListenerDefinition(exportedListener.value)) {
      throw new Error(`Discovered listener "${relativePath}" does not export a Holo listener.`)
    }

    let eventNames: readonly string[]
    try {
      eventNames = resolveListenerEventNamesForDiscovery(
        exportedListener.value as MinimalListenerDefinition,
        eventNamesByReference,
      )
    } catch (error) {
      if (
        !(error instanceof Error)
        || error.message !== '[Holo Events] Listener event references must resolve to explicit event names before discovery registration.'
      ) {
        /* v8 ignore next 3 -- defensive passthrough for unexpected listener discovery errors */
        throw error
      }

      eventNames = await resolveListenerEventNamesFromSource(projectRoot, filePath, discoveredEventNamesBySourcePath)
    }
    const normalizedListener = eventsDiscovery!.normalizeListenerDefinition(exportedListener.value)
    const listenerId = normalizedListener.name?.trim() || deriveListenerIdFromPath(listenersRoot, filePath)
    for (const eventName of eventNames) {
      if (!discoveredEventNames.has(eventName)) {
        throw new Error(`Listener "${listenerId}" references unknown event "${eventName}".`)
      }
    }

    listeners.push({
      sourcePath: relativePath,
      id: listenerId,
      eventNames,
      exportName: exportedListener.exportName,
    })
  }
  assertUniqueEntries('listener', listeners.map(entry => ({
    name: entry.id,
    sourcePath: entry.sourcePath,
  })))
  listeners.sort((left, right) => left.id.localeCompare(right.id))

  const broadcastDiscovery = (broadcastFiles.length > 0 || channelFiles.length > 0)
    ? await loadBroadcastDiscoveryModule(projectRoot)
    : undefined

  const broadcast: GeneratedBroadcastRegistryEntry[] = []
  for (const filePath of broadcastFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedBroadcast = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => broadcastDiscovery!.isBroadcastDefinition(value),
    )
    if (!exportedBroadcast) {
      throw new Error(`Discovered broadcast "${relativePath}" does not export a Holo broadcast definition.`)
    }

    const normalizedBroadcast = exportedBroadcast.value as {
      readonly name?: string
      readonly channels: readonly {
        readonly type: 'public' | 'private' | 'presence'
        readonly pattern: string
      }[]
    }
    broadcast.push({
      sourcePath: relativePath,
      name: normalizedBroadcast.name?.trim() || deriveBroadcastNameFromPath(broadcastRoot, filePath),
      exportName: exportedBroadcast.exportName,
      channels: normalizedBroadcast.channels.map(channel => ({
        type: channel.type,
        pattern: channel.pattern,
      })),
    })
  }
  assertUniqueEntries('broadcast', broadcast)

  const channels: GeneratedChannelRegistryEntry[] = []
  for (const filePath of channelFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedChannel = resolveNamedExportEntry(
      await importProjectModule(projectRoot, filePath),
      (value): value is object => broadcastDiscovery!.isChannelDefinition(value),
    )
    if (!exportedChannel) {
      throw new Error(`Discovered channel "${relativePath}" does not export a Holo channel definition.`)
    }

    const normalizedChannel = exportedChannel.value as {
      readonly pattern: string
      readonly type: 'private' | 'presence'
      readonly whispers: Readonly<Record<string, unknown>>
    }
    const pattern = normalizedChannel.pattern || deriveChannelPatternFromPath(channelsRoot, filePath)
    channels.push({
      sourcePath: relativePath,
      pattern,
      exportName: exportedChannel.exportName,
      type: normalizedChannel.type,
      params: broadcastDiscovery!.broadcastInternals.extractChannelPatternParamNames(pattern),
      whispers: Object.freeze(Object.keys(normalizedChannel.whispers)),
    })
  }
  assertUniqueEntries('channel', channels.map(entry => ({
    name: entry.pattern,
    sourcePath: entry.sourcePath,
  })))

  const registry: GeneratedProjectRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    paths: {
      models: config.paths.models,
      migrations: config.paths.migrations,
      seeders: config.paths.seeders,
      commands: config.paths.commands,
      jobs: config.paths.jobs,
      events: config.paths.events,
      listeners: config.paths.listeners,
      broadcast: 'server/broadcast',
      channels: 'server/channels',
      generatedSchema: config.paths.generatedSchema,
    },
    models,
    migrations,
    seeders,
    commands,
    jobs,
    events,
    listeners,
    broadcast,
    channels,
  }

  await writeGeneratedProjectRegistry(projectRoot, registry)
  return registry
}

export async function discoverAppCommands(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
): Promise<DiscoveredAppCommand[]> {
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, config)

  return [...registry.commands]
    .map(entry => ({
      sourcePath: entry.sourcePath,
      name: entry.name,
      aliases: entry.aliases,
      description: entry.description,
      ...(entry.usage ? { usage: entry.usage } : {}),
      async load() {
        const moduleValue = await importProjectModule(projectRoot, resolve(projectRoot, entry.sourcePath))
        const command = resolveCommandExport(moduleValue)
        if (!command) {
          throw new Error(`Discovered command "${entry.sourcePath}" does not export a Holo command.`)
        }

        return command
      },
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function loadRegisteredModels(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<CliModelReference[]> {
  const models: CliModelReference[] = []

  for (const entry of config.models) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const model = resolveNamedExport(moduleValue, isCliModelReference)
    if (!model) {
      throw new Error(`Registered model "${entry}" does not export a Holo model.`)
    }

    models.push(model)
  }

  return models
}

export async function loadRegisteredMigrations(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<MigrationDefinition[]> {
  const migrations: MigrationDefinition[] = []

  for (const entry of config.migrations) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const migration = resolveNamedExport(moduleValue, isMigrationDefinition)
    if (!migration) {
      throw new Error(`Registered migration "${entry}" does not export a Holo migration.`)
    }

    migrations.push({
      ...migration,
      name: migration.name ? validateMigrationName(migration.name) : inferMigrationNameFromEntry(entry),
    })
  }

  return migrations
}

function inferMigrationNameFromEntry(entry: string): string {
  const fileName = basename(entry, extname(entry))
  return validateMigrationName(
    fileName,
    `Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`,
  )
}

function validateMigrationName(name: string, message?: string): string {
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(
      message ?? `Migration name "${name}" must match YYYY_MM_DD_HHMMSS_description.`,
    )
  }

  return name
}

export async function loadRegisteredSeeders(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<SeederDefinition[]> {
  const seeders: SeederDefinition[] = []

  for (const entry of config.seeders) {
    const moduleValue = await importProjectModule(projectRoot, resolveRegisteredPath(projectRoot, entry))
    const seeder = resolveNamedExport(moduleValue, isSeederDefinition)
    if (!seeder) {
      throw new Error(`Registered seeder "${entry}" does not export a Holo seeder.`)
    }

    seeders.push(seeder)
  }

  return seeders
}

export {
  collectImportedBindingsBySource,
  extractListensToItems,
  resolveListenerEventNamesForDiscovery,
  resolveListenerEventNamesFromSource,
  resolveNamedExport,
  resolveNamedExportEntry,
}
