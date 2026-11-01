import { resolve } from 'node:path'
import {
  normalizeHoloProjectConfig,
  type NormalizedHoloProjectConfig,
} from '@holo-js/kernel'
import type { MigrationDefinition, SeederDefinition } from '@holo-js/db'
import { loadGeneratedProjectRegistry, writeGeneratedProjectRegistry } from './registry'
import {
  createProjectModuleBatch,
  loadAuthorizationDiscoveryModule,
  loadBroadcastDiscoveryModule,
  loadEventsDiscoveryModule,
  loadQueueDiscoveryModule,
  type ProjectModuleBatch,
} from './runtime'
import {
  type CliModelReference,
  type DiscoveredAppCommand,
  type GeneratedCommandRegistryEntry,
  type GeneratedAuthorizationAbilityRegistryEntry,
  type GeneratedAuthorizationPolicyRegistryEntry,
  type GeneratedBroadcastRegistryEntry,
  type GeneratedChannelRegistryEntry,
  type GeneratedEventRegistryEntry,
  type GeneratedJobRegistryEntry,
  type GeneratedListenerRegistryEntry,
  type GeneratedMigrationRegistryEntry,
  type GeneratedModelRegistryEntry,
  type GeneratedProjectRegistry,
  type GeneratedSeederRegistryEntry,
  type MinimalListenerDefinition,
  makeProjectRelativePath,
  pathExists,
} from './shared'
import {
  assertUniqueCommandTokens,
  assertUniqueEntries,
  captureAuthorizationDefinitionNames,
  collectFiles,
  deriveBroadcastNameFromPath,
  deriveChannelPatternFromPath,
  deriveCommandNameFromPath,
  deriveEventNameFromPath,
  deriveJobNameFromPath,
  deriveListenerIdFromPath,
  findAddedAuthorizationDefinitionNames,
  hasEventDefinitionMarker,
  hasListenerDefinitionMarker,
  importProjectModule,
  inferMigrationNameFromEntry,
  isCliModelReference,
  isInactiveGeneratedModelModule,
  isMigrationDefinition,
  isUnresolvedModelSchemaError,
  isSeederDefinition,
  normalizeCommandAliases,
  resolveAuthorizationTargetName,
  resolveBroadcastArtifactsPath,
  resolveCommandExport,
  resolveDiscoveredJobMetadata,
  resolveListenerEventNamesForDiscovery,
  resolveListenerEventNamesFromSource,
  resolveNamedExport,
  resolveNamedExportEntry,
  resolveRegisteredPath,
  unregisterAuthorizationDefinitionNames,
  validateMigrationName,
} from './discovery-helpers'
import type { BroadcastDiscoveryModule } from './shared'
import { loadConfigWithNormalizers } from './load-config'

type BroadcastExportEntry = {
  readonly exportName: string
  readonly value: {
    readonly name?: string
    readonly channels: readonly {
      readonly type: 'public' | 'private' | 'presence'
      readonly pattern: string
    }[]
  }
}

function resolveBroadcastExportEntry(
  moduleValue: unknown,
  discovery: BroadcastDiscoveryModule,
): BroadcastExportEntry | undefined {
  if (!moduleValue || typeof moduleValue !== 'object') {
    return undefined
  }

  const entries = Object.entries(moduleValue)
  const orderedEntries = 'default' in moduleValue
    ? [
        ['default', (moduleValue as { default?: unknown }).default] as const,
        ...entries.filter(([exportName]) => exportName !== 'default'),
      ]
    : entries

  for (const [exportName, value] of orderedEntries) {
    if (discovery.isBroadcastDefinition(value)) {
      return { exportName, value: value as BroadcastExportEntry['value'] }
    }

    if (typeof value === 'function') {
      const resolved = value(...Array.from({ length: value.length }, () => '__holo_discovery__'))
      if (discovery.isBroadcastDefinition(resolved)) {
        return { exportName, value: resolved as BroadcastExportEntry['value'] }
      }
    }
  }

  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function bundleCommandModules(
  modules: ProjectModuleBatch,
  commandFiles: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const bundleErrors = new Map<string, string>()
  try {
    await modules.bundle(commandFiles)
    return bundleErrors
  } catch {
    for (const filePath of commandFiles) {
      await modules.bundle([filePath]).catch((error: unknown) => bundleErrors.set(filePath, errorMessage(error)))
    }
    return bundleErrors
  }
}

async function importCommandModule(
  modules: ProjectModuleBatch,
  filePath: string,
): Promise<{ readonly moduleValue: unknown } | { readonly loadError: string }> {
  try {
    return { moduleValue: await modules.import(filePath) }
  } catch (error) {
    return { loadError: errorMessage(error) }
  }
}

export async function prepareProjectDiscovery(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
  prepareFramework = true,
): Promise<GeneratedProjectRegistry> {
  const modules = createProjectModuleBatch(projectRoot)
  try {
    return await discoverProjectRegistry(projectRoot, config, prepareFramework, modules)
  } finally {
    await modules.cleanup()
  }
}

async function discoverProjectRegistry(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  prepareFramework: boolean,
  modules: ProjectModuleBatch,
): Promise<GeneratedProjectRegistry> {
  const loadedConfig = await loadConfigWithNormalizers(projectRoot, {
    processEnv: process.env,
  })
  const modelsRoot = resolve(projectRoot, config.paths.models)
  const migrationsRoot = resolve(projectRoot, config.paths.migrations)
  const seedersRoot = resolve(projectRoot, config.paths.seeders)
  const commandsRoot = resolve(projectRoot, config.paths.commands)
  const jobsRoot = resolve(projectRoot, config.paths.jobs)
  const eventsRoot = resolve(projectRoot, config.paths.events)
  const listenersRoot = resolve(projectRoot, config.paths.listeners)
  const broadcastPath = resolveBroadcastArtifactsPath(config, 'broadcast')
  const channelsPath = resolveBroadcastArtifactsPath(config, 'channels')
  const broadcastRoot = resolve(projectRoot, broadcastPath)
  const channelsRoot = resolve(projectRoot, channelsPath)
  const policiesRoot = resolve(projectRoot, config.paths.authorizationPolicies ?? 'server/policies')
  const abilitiesRoot = resolve(projectRoot, config.paths.authorizationAbilities ?? 'server/abilities')
  const generatedSchemaPath = resolve(projectRoot, config.paths.generatedSchema)

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
  const [policyFiles, abilityFiles] = await Promise.all([
    collectFiles(policiesRoot),
    collectFiles(abilitiesRoot),
  ])
  const hasGeneratedSchema = await pathExists(generatedSchemaPath)
  await modules.bundle([
    ...(hasGeneratedSchema ? [generatedSchemaPath] : []),
    ...modelFiles,
    ...migrationFiles,
    ...seederFiles,
    ...jobFiles,
    ...eventFiles,
    ...listenerFiles,
    ...broadcastFiles,
    ...channelFiles,
    ...policyFiles,
    ...abilityFiles,
  ])
  if (hasGeneratedSchema) {
    await modules.import(generatedSchemaPath)
  }
  const commandBundleErrors = await bundleCommandModules(modules, commandFiles)

  const models: GeneratedModelRegistryEntry[] = []
  for (const filePath of modelFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    try {
      const moduleValue = await modules.import(filePath)
      const exportedModel = resolveNamedExportEntry(moduleValue, isCliModelReference)
      if (!exportedModel) {
        if (isInactiveGeneratedModelModule(moduleValue)) {
          continue
        }

        throw new Error(`Discovered model "${relativePath}" does not export a Holo model.`)
      }

      models.push({
        sourcePath: relativePath,
        name: exportedModel.value.definition.name,
        tableName: exportedModel.value.definition.table.tableName,
        prunable: Boolean(exportedModel.value.definition.prunable),
        ...(exportedModel.exportName === 'default' ? {} : { exportName: exportedModel.exportName }),
      })
    } catch (error) {
      if (!isUnresolvedModelSchemaError(error)) {
        throw error
      }
    }
  }
  assertUniqueEntries('model', models)

  const migrations: GeneratedMigrationRegistryEntry[] = []
  for (const filePath of migrationFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await modules.import(filePath)
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
    try {
      const moduleValue = await modules.import(filePath)
      const seeder = resolveNamedExport(moduleValue, isSeederDefinition)
      if (!seeder) {
        throw new Error(`Discovered seeder "${relativePath}" does not export a Holo seeder.`)
      }

      seeders.push({
        sourcePath: relativePath,
        name: seeder.name,
      })
    } catch (error) {
      if (!isUnresolvedModelSchemaError(error)) {
        throw error
      }
    }
  }
  assertUniqueEntries('seeder', seeders)

  const commands: GeneratedCommandRegistryEntry[] = []
  const failedCommands: GeneratedCommandRegistryEntry[] = []
  for (const filePath of commandFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const bundleError = commandBundleErrors.get(filePath)
    const loaded = bundleError === undefined ? await importCommandModule(modules, filePath) : { loadError: bundleError }
    if ('loadError' in loaded) {
      failedCommands.push({
        sourcePath: relativePath,
        name: deriveCommandNameFromPath(commandsRoot, filePath),
        aliases: [],
        description: `Failed to load: ${loaded.loadError}`,
        loadFailed: true,
      })
      continue
    }

    const command = resolveCommandExport(loaded.moduleValue)
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
  commands.push(...failedCommands)

  const jobs: GeneratedJobRegistryEntry[] = []
  const queueDiscovery = jobFiles.length > 0
    ? await loadQueueDiscoveryModule(projectRoot)
    : undefined
  for (const filePath of jobFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const moduleValue = await modules.import(filePath)
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
      await modules.import(filePath),
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
      await modules.import(filePath),
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
    const exportedBroadcast = resolveBroadcastExportEntry(
      await modules.import(filePath),
      broadcastDiscovery!,
    )
    if (!exportedBroadcast) {
      throw new Error(`Discovered broadcast "${relativePath}" does not export a Holo broadcast definition.`)
    }

    const normalizedBroadcast = exportedBroadcast.value
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
  broadcast.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))

  const channels: GeneratedChannelRegistryEntry[] = []
  for (const filePath of channelFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const exportedChannel = resolveNamedExportEntry(
      await modules.import(filePath),
      (value): value is object => broadcastDiscovery!.isChannelDefinition(value),
    )
    if (!exportedChannel) {
      throw new Error(`Discovered channel "${relativePath}" does not export a Holo channel definition.`)
    }

    const normalizedChannel = exportedChannel.value as {
      readonly pattern: string
      readonly type: 'private' | 'presence'
      readonly guard?: unknown
      readonly whispers: Readonly<Record<string, unknown>>
    }
    const pattern = normalizedChannel.pattern || deriveChannelPatternFromPath(channelsRoot, filePath)
    channels.push({
      sourcePath: relativePath,
      pattern,
      exportName: exportedChannel.exportName,
      ...(typeof normalizedChannel.guard === 'string' ? { guard: normalizedChannel.guard } : {}),
      type: normalizedChannel.type,
      params: broadcastDiscovery!.broadcastInternals.extractChannelPatternParamNames(pattern),
      whispers: Object.freeze(Object.keys(normalizedChannel.whispers)),
    })
  }
  assertUniqueEntries('channel', channels.map(entry => ({
    name: entry.pattern,
    sourcePath: entry.sourcePath,
  })))
  channels.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))

  const authorizationDiscovery = (policyFiles.length > 0 || abilityFiles.length > 0)
    ? await loadAuthorizationDiscoveryModule(projectRoot)
    : undefined

  const authorizationPolicies: GeneratedAuthorizationPolicyRegistryEntry[] = []
  for (const filePath of policyFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const authorizationStateBeforeImport = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
    const existingPolicyNames = captureAuthorizationDefinitionNames(authorizationStateBeforeImport.policiesByName)
    const existingAbilityNames = captureAuthorizationDefinitionNames(authorizationStateBeforeImport.abilitiesByName)

    try {
      const exportedPolicy = resolveNamedExportEntry(
        await modules.import(filePath),
        (value): value is object => authorizationDiscovery!.isAuthorizationPolicyDefinition(value),
      )
      if (!exportedPolicy) {
        throw new Error(`Discovered policy "${relativePath}" does not export a Holo policy.`)
      }

      const authorizationStateAfterImport = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
      const addedPolicyNames = findAddedAuthorizationDefinitionNames(authorizationStateAfterImport.policiesByName, existingPolicyNames)
      const addedAbilityNames = findAddedAuthorizationDefinitionNames(authorizationStateAfterImport.abilitiesByName, existingAbilityNames)

      if (addedPolicyNames.length !== 1 || addedAbilityNames.length !== 0) {
        throw new Error(
          `Discovered policy "${relativePath}" must register exactly one Holo policy and zero Holo abilities (found ${addedPolicyNames.length} policies and ${addedAbilityNames.length} abilities).`,
        )
      }

      const normalizedPolicy = exportedPolicy.value as {
        readonly name: string
        readonly target: object
        readonly class?: Readonly<Record<string, unknown>>
        readonly record?: Readonly<Record<string, unknown>>
      }
      authorizationPolicies.push({
        sourcePath: relativePath,
        name: normalizedPolicy.name.trim(),
        exportName: exportedPolicy.exportName,
        target: resolveAuthorizationTargetName(normalizedPolicy.target) ?? 'Object',
        classActions: Object.freeze(Object.keys(normalizedPolicy.class ?? {})),
        recordActions: Object.freeze(Object.keys(normalizedPolicy.record ?? {})),
      })
    } finally {
      const authorizationStateAfterDiscovery = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
      unregisterAuthorizationDefinitionNames(
        authorizationDiscovery!,
        findAddedAuthorizationDefinitionNames(authorizationStateAfterDiscovery.policiesByName, existingPolicyNames),
        findAddedAuthorizationDefinitionNames(authorizationStateAfterDiscovery.abilitiesByName, existingAbilityNames),
      )
    }
  }
  assertUniqueEntries('policy', authorizationPolicies.map(entry => ({
    name: entry.name,
    sourcePath: entry.sourcePath,
  })))
  authorizationPolicies.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))

  const authorizationAbilities: GeneratedAuthorizationAbilityRegistryEntry[] = []
  for (const filePath of abilityFiles) {
    const relativePath = makeProjectRelativePath(projectRoot, filePath)
    const authorizationStateBeforeImport = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
    const existingPolicyNames = captureAuthorizationDefinitionNames(authorizationStateBeforeImport.policiesByName)
    const existingAbilityNames = captureAuthorizationDefinitionNames(authorizationStateBeforeImport.abilitiesByName)

    try {
      const exportedAbility = resolveNamedExportEntry(
        await modules.import(filePath),
        (value): value is object => authorizationDiscovery!.isAuthorizationAbilityDefinition(value),
      )
      if (!exportedAbility) {
        throw new Error(`Discovered ability "${relativePath}" does not export a Holo ability.`)
      }

      const authorizationStateAfterImport = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
      const addedPolicyNames = findAddedAuthorizationDefinitionNames(authorizationStateAfterImport.policiesByName, existingPolicyNames)
      const addedAbilityNames = findAddedAuthorizationDefinitionNames(authorizationStateAfterImport.abilitiesByName, existingAbilityNames)

      if (addedPolicyNames.length !== 0 || addedAbilityNames.length !== 1) {
        throw new Error(
          `Discovered ability "${relativePath}" must register exactly one Holo ability and zero Holo policies (found ${addedPolicyNames.length} policies and ${addedAbilityNames.length} abilities).`,
        )
      }

      const normalizedAbility = exportedAbility.value as {
        readonly name: string
      }

      authorizationAbilities.push({
        sourcePath: relativePath,
        name: normalizedAbility.name.trim(),
        exportName: exportedAbility.exportName,
      })
    } finally {
      const authorizationStateAfterDiscovery = authorizationDiscovery!.authorizationInternals.getAuthorizationRuntimeState()
      unregisterAuthorizationDefinitionNames(
        authorizationDiscovery!,
        findAddedAuthorizationDefinitionNames(authorizationStateAfterDiscovery.policiesByName, existingPolicyNames),
        findAddedAuthorizationDefinitionNames(authorizationStateAfterDiscovery.abilitiesByName, existingAbilityNames),
      )
    }
  }
  assertUniqueEntries('ability', authorizationAbilities.map(entry => ({
    name: entry.name,
    sourcePath: entry.sourcePath,
  })))
  authorizationAbilities.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))

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
      broadcast: broadcastPath,
      channels: channelsPath,
      authorizationPolicies: config.paths.authorizationPolicies ?? 'server/policies',
      authorizationAbilities: config.paths.authorizationAbilities ?? 'server/abilities',
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
    authorizationPolicies,
    authorizationAbilities,
  }

  await writeGeneratedProjectRegistry(projectRoot, registry, prepareFramework)
  return registry
}

function withoutShadowedFailedCommands(
  entries: readonly GeneratedCommandRegistryEntry[],
): GeneratedCommandRegistryEntry[] {
  const tokens = new Set(entries.filter(entry => !entry.loadFailed).flatMap(entry => [entry.name, ...entry.aliases]))
  return entries.filter((entry) => {
    if (!entry.loadFailed) return true
    if (tokens.has(entry.name)) return false
    tokens.add(entry.name)
    return true
  })
}

export async function discoverAppCommands(
  projectRoot: string,
  config: NormalizedHoloProjectConfig = normalizeHoloProjectConfig(),
): Promise<DiscoveredAppCommand[]> {
  const cachedRegistry = await loadGeneratedProjectRegistry(projectRoot)
  const registry = cachedRegistry && !cachedRegistry.commands.some(entry => entry.loadFailed)
    ? cachedRegistry
    : await prepareProjectDiscovery(projectRoot, config)

  return withoutShadowedFailedCommands(registry.commands)
    .map(entry => ({
      sourcePath: entry.sourcePath,
      name: entry.name,
      aliases: entry.aliases,
      description: entry.description,
      ...(entry.usage ? { usage: entry.usage } : {}),
      ...(entry.loadFailed ? { loadFailed: entry.loadFailed } : {}),
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
} from './discovery-helpers'
