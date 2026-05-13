import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { loadConfigDirectory } from '@holo-js/config'
import type { MigrationDefinition, NormalizedHoloProjectConfig, SeederDefinition } from '@holo-js/db'
import type { HoloAppCommand } from '../types'
import { importProjectModule, readTextFile } from './runtime'
import {
  COMMAND_FILE_PATTERN,
  MIGRATION_NAME_PATTERN,
  type CliModelReference,
  type AuthorizationDiscoveryModule,
  type GeneratedCommandRegistryEntry,
  type GeneratedJobRegistryEntry,
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

export async function collectFiles(root: string): Promise<string[]> {
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

export function deriveCommandNameFromPath(commandsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(commandsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join(':')
}

export function deriveJobNameFromPath(jobsRoot: string, sourcePath: string): string {
  const relativePath = toPosixPath(relative(jobsRoot, sourcePath))
  return relativePath
    .replace(COMMAND_FILE_PATTERN, '')
    .split('/')
    .filter(Boolean)
    .join('.')
}

export function deriveEventNameFromPath(eventsRoot: string, sourcePath: string): string {
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

export function deriveListenerIdFromPath(listenersRoot: string, sourcePath: string): string {
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

export function deriveBroadcastNameFromPath(root: string, sourcePath: string): string {
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

export function deriveChannelPatternFromPath(root: string, sourcePath: string): string {
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

export function resolveDiscoveredJobMetadata(
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

export function isAppCommand(value: unknown): value is HoloAppCommand {
  return isRecord(value)
    && typeof value.description === 'string'
    && typeof value.run === 'function'
}

export function resolveCommandExport(moduleValue: unknown): HoloAppCommand | undefined {
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

export function normalizeCommandAliases(value: readonly string[] | undefined): readonly string[] | undefined {
  if (!value) {
    return undefined
  }

  const normalized = [...new Set(value.map(alias => alias.trim()).filter(Boolean))]
  return normalized.length > 0 ? normalized : undefined
}

export function assertUniqueEntries(
  kind: 'model' | 'migration' | 'seeder' | 'command' | 'job' | 'event' | 'listener' | 'broadcast' | 'channel' | 'policy' | 'ability',
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

export function assertUniqueCommandTokens(entries: readonly GeneratedCommandRegistryEntry[]): void {
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

export function resolveRegisteredPath(projectRoot: string, entry: string): string {
  return resolve(projectRoot, entry)
}

export function resolveNamedExport<TValue>(
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

export function resolveNamedExportEntry<TValue>(
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

export function isCliModelReference(value: unknown): value is CliModelReference {
  return isRecord(value)
    && isRecord(value.definition)
    && value.definition.kind === 'model'
    && typeof value.definition.name === 'string'
    && typeof value.prune === 'function'
}

export function isMissingGeneratedSchemaModelError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('is not present in the generated schema registry')
}

export function isInactiveGeneratedModelModule(value: unknown): value is InactiveGeneratedModelModule {
  return isRecord(value) && value.holoModelPendingSchema === true
}

export function isMigrationDefinition(value: unknown): value is MigrationDefinition {
  return isRecord(value)
    && typeof value.up === 'function'
}

export function isSeederDefinition(value: unknown): value is SeederDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.run === 'function'
}

export function resolveListenerEventNamesForDiscovery(
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

export function resolveAuthorizationTargetName(target: object): string | undefined {
  const modelFacadeTarget = target as { readonly definition?: { readonly name?: unknown } }
  if (typeof modelFacadeTarget.definition?.name === 'string' && modelFacadeTarget.definition.name.trim()) {
    return modelFacadeTarget.definition.name.trim()
  }

  const namedTarget = target as { readonly name?: unknown }
  return typeof namedTarget.name === 'string' && namedTarget.name.trim()
    ? namedTarget.name.trim()
    : undefined
}

export function captureAuthorizationDefinitionNames(definitions: ReadonlyMap<string, unknown>): Set<string> {
  return new Set(definitions.keys())
}

export function findAddedAuthorizationDefinitionNames(
  definitions: ReadonlyMap<string, unknown>,
  existingNames: ReadonlySet<string>,
): readonly string[] {
  return [...definitions.keys()].filter(name => !existingNames.has(name))
}

export function unregisterAuthorizationDefinitionNames(
  authorizationDiscovery: AuthorizationDiscoveryModule,
  policyNames: readonly string[],
  abilityNames: readonly string[],
): void {
  if (
    typeof authorizationDiscovery.authorizationInternals.unregisterPolicyDefinition !== 'function'
    || typeof authorizationDiscovery.authorizationInternals.unregisterAbilityDefinition !== 'function'
  ) {
    authorizationDiscovery.authorizationInternals.resetAuthorizationRuntimeState?.()
    return
  }

  for (const policyName of policyNames) {
    authorizationDiscovery.authorizationInternals.unregisterPolicyDefinition(policyName)
  }

  for (const abilityName of abilityNames) {
    authorizationDiscovery.authorizationInternals.unregisterAbilityDefinition(abilityName)
  }
}

export function collectImportedBindingsBySource(sourceText: string): ReadonlyMap<string, string> {
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

export function extractListensToItems(sourceText: string): readonly string[] {
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

export async function resolveListenerEventNamesFromSource(
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

export function resolveBroadcastArtifactsPath(
  config: NormalizedHoloProjectConfig,
  key: 'broadcast' | 'channels',
): string {
  const configuredPaths = config.paths as typeof config.paths & {
    readonly broadcast?: string
    readonly channels?: string
  }
  return configuredPaths[key] ?? `server/${key}`
}

export function inferMigrationNameFromEntry(entry: string): string {
  const fileName = basename(entry, extname(entry))
  return validateMigrationName(
    fileName,
    `Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`,
  )
}

export function validateMigrationName(name: string, message?: string): string {
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new Error(
      message ?? `Migration name "${name}" must match YYYY_MM_DD_HHMMSS_description.`,
    )
  }

  return name
}

export {
  hasEventDefinitionMarker,
  hasListenerDefinitionMarker,
  importProjectModule,
  isRecord,
}
