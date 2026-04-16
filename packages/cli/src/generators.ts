import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { normalizeMigrationSlug } from '@holo-js/db'
import {
  ensureGeneratedSchemaPlaceholder,
  ensureProjectConfig,
  loadGeneratedProjectRegistry,
  makeProjectRelativePath,
  prepareProjectDiscovery,
  resolveDefaultArtifactPath,
  writeTextFile,
} from './project'
import {
  ensureSuffix,
  relativeImportPath,
  renderBroadcastTemplate,
  renderChannelTemplate,
  renderEventTemplate,
  renderFactoryTemplate,
  renderJobTemplate,
  renderListenerTemplate,
  renderMarkdownMailTemplate,
  renderMultiListenerTemplate,
  renderModelTemplate,
  renderObserverTemplate,
  renderSeederTemplate,
  resolveArtifactPath,
  resolveNameInfo,
  splitRequestedName,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
} from './templates'
import { runProjectPrepare } from './dev'
import { resolveStringFlag } from './parsing'
import { ensureAbsent, fileExists } from './fs-utils'
import {
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  nextMigrationTemplate,
} from './migrations'
import { writeLine } from './io'
import type { IoStreams, PreparedInput } from './cli-types'

type MailTemplateType = 'markdown' | 'view'
type KnownMailViewFramework = 'nuxt' | 'next' | 'sveltekit'
const MAIL_VIEW_SCAFFOLDING_UNAVAILABLE_MESSAGE
  = 'View-backed mail scaffolding requires a renderView runtime binding, which the first-party app scaffolds do not configure yet. Use "--markdown" instead.'

export function hasRegisteredModelName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  modelName: string,
): boolean {
  return Boolean(registry?.models.some(entry => entry.name === modelName))
}

export function hasRegisteredJobName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  jobName: string,
): boolean {
  return Boolean(registry?.jobs.some(entry => entry.name === jobName))
}

export function hasRegisteredEventName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  eventName: string,
): boolean {
  return Boolean(registry?.events.some(entry => entry.name === eventName))
}

export function hasRegisteredListenerId(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  listenerId: string,
): boolean {
  return Boolean(registry?.listeners.some(entry => entry.id === listenerId))
}

function toChannelTemplateFileStem(pattern: string): string {
  const rawSegments = pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.+/, '')
    .split(/[/.]/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const hasOnlyWildcardSegments = rawSegments.length > 0 && rawSegments.every(segment => /^\{[^}]+\}$/.test(segment))

  const normalized = pattern
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.+/, '')
    .replace(/\{([^}]+)\}/g, '$1')
    .replace(/[^a-z0-9/]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '')

  const fileStem = normalized
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/') || 'channel'

  if (!hasOnlyWildcardSegments) {
    return fileStem
  }

  const suffix = createHash('sha1').update(pattern.trim()).digest('hex').slice(0, 8)
  return `${fileStem}-${suffix}`
}

function resolveChannelArtifactPath(
  projectRoot: string,
  channelsPath: string,
  pattern: string,
  registry: NonNullable<Awaited<ReturnType<typeof loadGeneratedProjectRegistry>>>,
): string {
  const fileStem = toChannelTemplateFileStem(pattern)
  const filePath = resolveArtifactPath(projectRoot, channelsPath, '', `${fileStem}.ts`)
  const relativePath = makeProjectRelativePath(projectRoot, filePath)
  const collidesWithDifferentRegisteredPattern = registry.channels.some(entry => {
    return entry.sourcePath === relativePath && entry.pattern !== pattern
  })

  if (!collidesWithDifferentRegisteredPattern) {
    return filePath
  }

  const suffix = createHash('sha1').update(pattern.trim()).digest('hex').slice(0, 8)
  return resolveArtifactPath(projectRoot, channelsPath, '', `${fileStem}-${suffix}.ts`)
}

async function resolveProjectMailViewFramework(projectRoot: string): Promise<KnownMailViewFramework | 'generic'> {
  try {
    const packageJson = await readFile(resolve(projectRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    const dependencies = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    }

    if (typeof dependencies.nuxt === 'string') {
      return 'nuxt'
    }

    if (typeof dependencies.next === 'string') {
      return 'next'
    }

    if (typeof dependencies['@sveltejs/kit'] === 'string') {
      return 'sveltekit'
    }
  } catch {
    return 'generic'
  }

  return 'generic'
}

export async function runMakeModel(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  /* v8 ignore next */
  const requestedName = String(input.args[0] ?? '')
  const options = {
    migration: input.flags.migration === true,
    observer: input.flags.observer === true,
    seeder: input.flags.seeder === true,
    factory: input.flags.factory === true,
  }
  const nameInfo = resolveNameInfo(requestedName)
  const explicitTableName = resolveStringFlag(input.flags, 'table')
  const tableName = explicitTableName ? toSnakeCase(explicitTableName) : nameInfo.tableName
  const modelFilePath = resolveArtifactPath(projectRoot, project.config.paths.models, nameInfo.directory, `${nameInfo.baseName}.ts`)
  const observerInfo = resolveNameInfo(`${requestedName}Observer`, { suffix: 'Observer' })
  const observerFilePath = resolveArtifactPath(projectRoot, project.config.paths.observers, observerInfo.directory, `${observerInfo.baseName}.ts`)
  const seederInfo = resolveNameInfo(`${requestedName}Seeder`, { suffix: 'Seeder' })
  const seederFilePath = resolveArtifactPath(projectRoot, project.config.paths.seeders, seederInfo.directory, `${seederInfo.baseName}.ts`)
  const factoryInfo = resolveNameInfo(`${requestedName}Factory`, { suffix: 'Factory' })
  const factoryFilePath = resolveArtifactPath(projectRoot, project.config.paths.factories, factoryInfo.directory, `${factoryInfo.baseName}.ts`)
  const generatedSchemaFilePath = await ensureGeneratedSchemaPlaceholder(projectRoot, project.config)

  if (await fileExists(modelFilePath) || hasRegisteredModelName(registry, nameInfo.baseName)) {
    throw new Error(`Model with the same name already exists: ${nameInfo.baseName}.`)
  }

  if (options.migration) {
    const migrationName = normalizeMigrationSlug(`create_${tableName}_table`)
    if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
      throw new Error(`A migration for table "${tableName}" already exists.`)
    }
  }

  await ensureAbsent(modelFilePath)
  if (options.observer) {
    await ensureAbsent(observerFilePath)
  }
  if (options.seeder) {
    await ensureAbsent(seederFilePath)
  }
  if (options.factory) {
    await ensureAbsent(factoryFilePath)
  }

  if (options.observer) {
    await writeTextFile(observerFilePath, renderObserverTemplate(observerInfo.baseName))
  }

  await writeTextFile(modelFilePath, renderModelTemplate({
    tableName,
    generatedSchemaImportPath: relativeImportPath(modelFilePath, generatedSchemaFilePath),
    ...(options.observer
      ? {
          observerImportPath: relativeImportPath(modelFilePath, observerFilePath),
          observerClassName: observerInfo.baseName,
        }
      /* v8 ignore next */
      : {}),
  }))

  if (options.factory) {
    await writeTextFile(factoryFilePath, renderFactoryTemplate(
      relativeImportPath(factoryFilePath, modelFilePath),
      nameInfo.baseName,
    ))
  }

  if (options.seeder) {
    await writeTextFile(seederFilePath, renderSeederTemplate(seederInfo.snakeStem))
  }

  if (options.migration) {
    const migrationName = normalizeMigrationSlug(`create_${tableName}_table`)
    const migrationTemplate = await nextMigrationTemplate(
      migrationName,
      resolve(projectRoot, project.config.paths.migrations),
    )
    const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)
    await writeTextFile(migrationFilePath, migrationTemplate.contents)
  }
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created model: ${makeProjectRelativePath(projectRoot, modelFilePath)}`)
  if (options.migration) {
    writeLine(io.stdout, `Registered migration for ${nameInfo.baseName}.`)
  }
  if (options.seeder) {
    writeLine(io.stdout, `Registered seeder for ${nameInfo.baseName}.`)
  }
}

export async function runMakeMigration(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  /* v8 ignore next */
  const requestedName = String(input.args[0] ?? '')
  const createTable = typeof input.flags.create === 'string' ? normalizeMigrationSlug(input.flags.create) : undefined
  const alterTable = typeof input.flags.table === 'string' ? normalizeMigrationSlug(input.flags.table) : undefined

  if (createTable && alterTable) {
    throw new Error('Use either "--create" or "--table", not both.')
  }

  const requestedSlug = normalizeMigrationSlug(requestedName)
  if (createTable) {
    if (hasRegisteredCreateTableMigration(registry, createTable)) {
      throw new Error(`A migration for table "${createTable}" already exists.`)
    }
  } else if (alterTable) {
    if (hasRegisteredMigrationSlug(registry, requestedSlug)) {
      throw new Error(`A migration named "${requestedSlug}" already exists.`)
    }
  } else if (hasRegisteredMigrationSlug(registry, requestedSlug)) {
    throw new Error(`A migration named "${requestedSlug}" already exists.`)
  }

  const migrationTemplate = await nextMigrationTemplate(
    requestedSlug,
    resolve(projectRoot, project.config.paths.migrations),
    {
      ...(createTable ? { kind: 'create_table' as const, tableName: createTable } : {}),
      ...(alterTable ? { kind: 'alter_table' as const, tableName: alterTable } : {}),
    },
  )
  const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)

  await writeTextFile(migrationFilePath, migrationTemplate.contents)
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, migrationFilePath)}`)
}

export async function runMakeSeeder(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Seeder' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.seeders, info.directory, `${info.baseName}.ts`)

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderSeederTemplate(info.snakeStem))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created seeder: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeJob(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.jobs, directory, `${fileStem}.ts`)
  const jobName = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredJobName(registry, jobName)) {
    throw new Error(`Job with the same name already exists: ${jobName}.`)
  }

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderJobTemplate())
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created job: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeEvent(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.events, directory, `${fileStem}.ts`)
  const eventName = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredEventName(registry, eventName)) {
    throw new Error(`Event with the same name already exists: ${eventName}.`)
  }

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderEventTemplate(eventName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created event: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeBroadcast(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const broadcastPath = registry.paths.broadcast
  const filePath = resolveArtifactPath(projectRoot, broadcastPath, directory, `${fileStem}.ts`)
  const eventName = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || registry.broadcast.some(entry => entry.name === eventName)) {
    throw new Error(`Broadcast with the same name already exists: ${eventName}.`)
  }

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderBroadcastTemplate(eventName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created broadcast: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeChannel(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const pattern = String(input.args[0] ?? '').trim()
  if (!pattern) {
    throw new Error('A channel pattern is required.')
  }

  if (registry.channels.some(entry => entry.pattern === pattern)) {
    throw new Error(`Channel with the same pattern already exists: ${pattern}.`)
  }

  const channelsPath = registry.paths.channels
  const filePath = resolveChannelArtifactPath(projectRoot, channelsPath, pattern, registry)

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderChannelTemplate(pattern))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created channel: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeListener(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const requestedEvents = Array.isArray(input.flags.event)
    ? input.flags.event.map(value => String(value).trim()).filter(Boolean)
    : [String(input.flags.event ?? '').trim()].filter(Boolean)
  const eventNames = [...new Set(requestedEvents)]
  const eventEntries = eventNames.map((eventName) => {
    const entry = registry?.events.find(candidate => candidate.name === eventName)
    if (!entry) {
      throw new Error(`Unknown event: ${eventName}.`)
    }

    return entry
  })

  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.listeners, directory, `${fileStem}.ts`)
  const listenerId = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredListenerId(registry, listenerId)) {
    throw new Error(`Listener with the same id already exists: ${listenerId}.`)
  }

  const templateEvents = eventEntries.map((eventEntry, index) => {
    const sourceEventBaseName = eventEntry.sourcePath.split('/').pop()!.replace(/\.[^.]+$/, '')
    const importName = `${toPascalCase(sourceEventBaseName)}Event${index + 1}`
    const importPath = relativeImportPath(filePath, resolve(projectRoot, eventEntry.sourcePath))
    return {
      importName,
      importStatement: eventEntry.exportName && eventEntry.exportName !== 'default'
        ? `import { ${eventEntry.exportName} as ${importName} } from '${importPath}'`
        : `import ${importName} from '${importPath}'`,
    }
  })

  await ensureAbsent(filePath)
  await writeTextFile(
    filePath,
    templateEvents.length === 1
      ? renderListenerTemplate(templateEvents[0]!.importStatement, templateEvents[0]!.importName)
      : renderMultiListenerTemplate(templateEvents),
  )
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created listener: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeObserver(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Observer' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.observers, info.directory, `${info.baseName}.ts`)

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderObserverTemplate(info.baseName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created observer: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeFactory(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Factory' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.factories, info.directory, `${info.baseName}.ts`)
  const baseName = info.baseStem
  const modelInfo = splitRequestedName(baseName)
  const modelFilePath = resolveArtifactPath(
    projectRoot,
    project.config.paths.models,
    info.directory,
    `${toPascalCase(modelInfo.rawBaseName)}.ts`,
  )

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderFactoryTemplate(
    relativeImportPath(filePath, modelFilePath),
    toPascalCase(modelInfo.rawBaseName),
  ))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created factory: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

export async function runMakeMail(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  await ensureProjectConfig(projectRoot)
  const requestedName = String(input.args[0] ?? '')
  const templateType: MailTemplateType = input.flags.type === 'view' ? 'view' : 'markdown'
  if (templateType === 'view') {
    throw new Error(MAIL_VIEW_SCAFFOLDING_UNAVAILABLE_MESSAGE)
  }
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const mailName = ensureSuffix(toPascalCase(nameParts.rawBaseName), 'Mail')
  const inputTypeName = `${mailName}Input`
  const mailFilePath = resolveArtifactPath(projectRoot, 'server/mail', directory, `${fileStem}.ts`)

  await ensureAbsent(mailFilePath)

  await writeTextFile(mailFilePath, renderMarkdownMailTemplate(mailName, inputTypeName))
  await runProjectPrepare(projectRoot)
  writeLine(io.stdout, `Created mail: ${makeProjectRelativePath(projectRoot, mailFilePath)}`)
}

export const generatorInternals = {
  resolveProjectMailViewFramework,
  toChannelTemplateFileStem,
}
