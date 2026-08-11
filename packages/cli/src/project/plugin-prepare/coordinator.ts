import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import {
  HOLO_PROJECT_PREPARE_API_VERSION,
  HoloProjectPrepareError,
  type HoloProjectArtifactContents,
  type HoloProjectPrepareDiagnostic,
  type HoloProjectPrepareFramework,
  type HoloProjectPrepareRun,
  type HoloProjectPrepareWatch,
  type NormalizedHoloProjectConfig,
} from '@holo-js/kernel'
import { type LoadedHoloPlugin, loadProjectPluginPreparation, type LoadedProjectPreparer } from '../plugins'
import {
  assertManagedPathAllowed,
  assertNoSymbolicLinkParents,
  assertNoSymbolicLinks,
  isPathInside,
  normalizeArtifactPath,
  platformPathKey,
  resolveContainedPath,
} from './paths'

const MAX_ARTIFACTS = 2_000
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_DIAGNOSTICS = 200
const MANIFEST_VERSION = 1
const PREPARE_LOCK_WAIT_MS = 30_000
const ABANDONED_PREPARE_LOCK_MS = 30_000
const PREPARE_LOCK_HEARTBEAT_MS = 10_000
const PROCESS_INSTANCE_TOKEN = randomUUID()

type OwnedArtifact = {
  readonly path: string
  readonly digest: string
}

type OwnershipManifest = {
  readonly version: typeof MANIFEST_VERSION
  readonly pluginId: string
  readonly packageName: string
  readonly apiVersion: typeof HOLO_PROJECT_PREPARE_API_VERSION
  readonly generatedArtifacts: readonly OwnedArtifact[]
  readonly managedArtifacts: readonly OwnedArtifact[]
  readonly watch: HoloProjectPrepareWatch
  readonly frameworkId?: string
}

type PreparedArtifact = OwnedArtifact & {
  readonly absolutePath: string
  readonly contents: Uint8Array
}

type PreparedSnapshot = {
  readonly plugin: LoadedProjectPreparer
  readonly generatedArtifacts: readonly PreparedArtifact[]
  readonly managedArtifacts: readonly PreparedArtifact[]
  readonly diagnostics: readonly HoloProjectPrepareDiagnostic[]
  readonly watch: HoloProjectPrepareWatch
  readonly previous?: OwnershipManifest
  readonly frameworkId?: string
}

type StagedWrite = {
  readonly target: string
  readonly temporary: string
  readonly plugin: LoadedProjectPreparer
}

type PendingRemoval = {
  readonly root: string
  readonly target: string
  readonly recursive?: boolean
}

type CommittedMutation = {
  rollback(): Promise<void>
  finalize(): Promise<void>
}

type PrepareLockOwner = {
  readonly host: string
  readonly pid: number
  readonly processToken?: string
  readonly token: string
}

type PrepareLockIdentity = {
  readonly device: number
  readonly inode: number
  readonly modifiedAt: number
  readonly owner?: PrepareLockOwner
}

export interface RunPluginPreparationOptions {
  readonly run: HoloProjectPrepareRun
  readonly framework?: HoloProjectPrepareFramework
  readonly signal?: AbortSignal
  writeInfo?(message: string): void
  writeWarning?(message: string): void
}

function digest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function encodeContents(contents: HoloProjectArtifactContents): Uint8Array {
  if (typeof contents === 'string') {
    return Buffer.from(contents, 'utf8')
  }
  if (contents instanceof Uint8Array) {
    return new Uint8Array(contents)
  }
  throw new Error('Artifact contents must be a string or Uint8Array.')
}

function hostError(code: string, plugin: LoadedProjectPreparer, message: string, hint?: string): HoloProjectPrepareError {
  return new HoloProjectPrepareError({
    code,
    message: `[Holo Plugins] ${plugin.plugin.definition.name ?? plugin.plugin.definition.id} (${plugin.plugin.packageName}) project.prepare ${plugin.specifier}: ${message}`,
    ...(hint ? { hint } : {}),
  })
}

function attributedError(plugin: LoadedProjectPreparer, failure: HoloProjectPrepareError['failure']): HoloProjectPrepareError {
  if (failure.message.startsWith('[Holo Plugins]')) {
    return new HoloProjectPrepareError(failure)
  }
  return new HoloProjectPrepareError({
    ...failure,
    message: `[Holo Plugins] ${plugin.plugin.definition.name ?? plugin.plugin.definition.id} (${plugin.plugin.packageName}) project.prepare ${plugin.specifier}: ${failure.message}`,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFileSystemError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function parsePrepareLockOwner(value: unknown): PrepareLockOwner | undefined {
  if (
    !isRecord(value)
    || typeof value.host !== 'string'
    || !value.host
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.token !== 'string'
    || !value.token
  ) {
    return undefined
  }
  const processToken = typeof value.processToken === 'string' && value.processToken
    ? value.processToken
    : undefined
  return Object.freeze({
    host: value.host,
    pid: value.pid as number,
    ...(processToken ? { processToken } : {}),
    token: value.token,
  })
}

async function readPrepareLockOwner(lockPath: string): Promise<PrepareLockOwner | undefined> {
  try {
    return parsePrepareLockOwner(JSON.parse(await readFile(resolve(lockPath, 'owner.json'), 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof SyntaxError || isFileSystemError(error, 'ENOENT')) return undefined
    throw error
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isFileSystemError(error, 'EPERM')
  }
}

async function readPrepareLockIdentity(lockPath: string): Promise<PrepareLockIdentity | undefined> {
  const owner = await readPrepareLockOwner(lockPath)
  const identityPath = owner ? resolve(lockPath, 'owner.json') : lockPath
  const identity = await stat(identityPath).catch(() => undefined)
  if (!identity) return undefined
  return Object.freeze({
    device: identity.dev,
    inode: identity.ino,
    modifiedAt: identity.mtimeMs,
    ...(owner ? { owner } : {}),
  })
}

function prepareLockIdentityMatches(left: PrepareLockIdentity, right: PrepareLockIdentity | undefined): boolean {
  return right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedAt === right.modifiedAt
    && left.owner?.token === right.owner?.token
}

async function reclaimablePrepareLock(lockPath: string): Promise<PrepareLockIdentity | undefined> {
  const identity = await readPrepareLockIdentity(lockPath)
  if (!identity) return undefined
  const owner = identity.owner
  if (owner?.host === hostname()) {
    if (owner.pid === process.pid) {
      if (owner.processToken === PROCESS_INSTANCE_TOKEN) return undefined
    } else {
      return processIsRunning(owner.pid) ? undefined : identity
    }
  }
  if (identity.modifiedAt > Date.now() - ABANDONED_PREPARE_LOCK_MS) return undefined

  return identity
}

async function restoreReplacedPrepareLock(lockPath: string, abandonedPath: string): Promise<void> {
  const existing = await stat(lockPath).catch(() => undefined)
  if (existing) {
    throw new HoloProjectPrepareError({
      code: 'HOLO_PLUGIN_PREPARE_LOCK_CHANGED',
      message: '[Holo Plugins] Project preparation lock changed during stale recovery.',
    })
  }
  await rename(abandonedPath, lockPath)
}

async function reclaimPrepareLock(lockPath: string, expected: PrepareLockIdentity): Promise<boolean> {
  const abandonedPath = `${lockPath}.${process.pid}.${randomUUID()}.abandoned`
  try {
    await rename(lockPath, abandonedPath)
  } catch (error) {
    if (isFileSystemError(error, 'ENOENT')) return true
    throw error
  }
  const moved = await readPrepareLockIdentity(abandonedPath)
  if (!prepareLockIdentityMatches(expected, moved)) {
    await restoreReplacedPrepareLock(lockPath, abandonedPath)
    return false
  }
  await rm(abandonedPath, { recursive: true, force: true })
  return true
}

async function acquireProjectPrepareLock(projectRoot: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lockPath = resolve(projectRoot, '.holo-js/project-prepare.lock')
  await mkdir(dirname(lockPath), { recursive: true })
  const startedAt = Date.now()
  const owner = Object.freeze({
    host: hostname(),
    pid: process.pid,
    processToken: PROCESS_INSTANCE_TOKEN,
    token: randomUUID(),
  })

  while (true) {
    try {
      await mkdir(lockPath)
      let ownerHandle
      try {
        ownerHandle = await open(resolve(lockPath, 'owner.json'), 'wx', 0o600)
        await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' })
        await ownerHandle.sync()
      } catch (error) {
        await ownerHandle?.close()
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      const heartbeat = setInterval(() => {
        const now = new Date()
        void ownerHandle.utimes(now, now).catch(() => undefined)
      }, PREPARE_LOCK_HEARTBEAT_MS)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        await ownerHandle.close()
        const currentOwner = await readPrepareLockOwner(lockPath)
        if (currentOwner?.token === owner.token) await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (!isFileSystemError(error, 'EEXIST')) throw error
      signal?.throwIfAborted()
      const reclaimable = await reclaimablePrepareLock(lockPath)
      if (reclaimable && await reclaimPrepareLock(lockPath, reclaimable)) continue
      if (Date.now() - startedAt >= PREPARE_LOCK_WAIT_MS) {
        throw new HoloProjectPrepareError({
          code: 'HOLO_PLUGIN_PREPARE_LOCK_TIMEOUT',
          message: '[Holo Plugins] Timed out waiting for another project preparation to finish.',
        })
      }
      await wait(10, undefined, signal ? { signal } : undefined)
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (typeof value === 'undefined') return undefined
  return requiredString(value, field)
}

function normalizeSource(value: unknown, field: string): HoloProjectPrepareDiagnostic['source'] {
  if (!isRecord(value)) throw new Error(`${field} must be an object.`)
  const path = normalizeArtifactPath(requiredString(value.path, `${field}.path`), true)
  const normalizePosition = (position: unknown, name: string): number | undefined => {
    if (typeof position === 'undefined') return undefined
    if (!Number.isSafeInteger(position) || (position as number) < 1) {
      throw new Error(`${name} must be a positive integer.`)
    }
    return position as number
  }
  const line = normalizePosition(value.line, `${field}.line`)
  const column = normalizePosition(value.column, `${field}.column`)
  return Object.freeze({ path, ...(line ? { line } : {}), ...(column ? { column } : {}) })
}

function parseWatch(value: unknown, field = 'watch'): HoloProjectPrepareWatch {
  if (typeof value === 'undefined') return Object.freeze({ roots: Object.freeze([]), excludes: Object.freeze([]) })
  if (!isRecord(value)) throw new Error(`${field} must be an object.`)
  const parsePaths = (candidate: unknown, name: string): readonly string[] => {
    if (typeof candidate === 'undefined') return Object.freeze([])
    if (!Array.isArray(candidate)) throw new Error(`${field}.${name} must be an array.`)
    const paths = candidate.map((entry, index) => normalizeArtifactPath(requiredString(entry, `${field}.${name}[${index}]`), true))
    return Object.freeze([...new Set(paths)].sort())
  }
  const roots = parsePaths(value.roots, 'roots')
  const excludes = parsePaths(value.excludes, 'excludes')
  for (const exclude of excludes) {
    if (!roots.some(root => root === '.' || exclude === root || exclude.startsWith(`${root}/`))) {
      throw new Error(`Watch exclusion ${exclude} is not below a declared watch root.`)
    }
  }
  return Object.freeze({ roots, excludes })
}

function parseOwnedArtifacts(value: unknown, field: string, managed: boolean): readonly OwnedArtifact[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`)
  const seen = new Set<string>()
  const artifacts = value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`${field}[${index}] must be an object.`)
    const path = normalizeArtifactPath(requiredString(candidate.path, `${field}[${index}].path`))
    if (managed) assertManagedPathAllowed(path, [])
    const artifactDigest = requiredString(candidate.digest, `${field}[${index}].digest`)
    if (!/^[a-f0-9]{64}$/.test(artifactDigest)) throw new Error(`${field}[${index}].digest must be a SHA-256 digest.`)
    const key = platformPathKey(path)
    if (seen.has(key)) throw new Error(`${field} contains duplicate path ${path}.`)
    seen.add(key)
    return Object.freeze({ path, digest: artifactDigest })
  })
  return Object.freeze(artifacts)
}

function parseManifest(value: unknown, expectedPluginId: string, expectedPackageName?: string): OwnershipManifest {
  if (!isRecord(value)) throw new Error('Ownership manifest must be an object.')
  if (value.version !== MANIFEST_VERSION) throw new Error(`Ownership manifest version must be ${MANIFEST_VERSION}.`)
  const pluginId = requiredString(value.pluginId, 'pluginId')
  if (!/^[a-z][a-z0-9-]*$/.test(pluginId)) throw new Error(`Ownership manifest pluginId ${pluginId} is not filesystem-safe.`)
  if (pluginId !== expectedPluginId) throw new Error(`Ownership manifest pluginId ${pluginId} does not match filename ${expectedPluginId}.`)
  const packageName = requiredString(value.packageName, 'packageName')
  if (expectedPackageName && packageName !== expectedPackageName) throw new Error(`Ownership manifest packageName ${packageName} does not match active package ${expectedPackageName}.`)
  if (value.apiVersion !== HOLO_PROJECT_PREPARE_API_VERSION) throw new Error(`Ownership manifest apiVersion must be ${HOLO_PROJECT_PREPARE_API_VERSION}.`)
  const frameworkId = optionalString(value.frameworkId, 'frameworkId')
  return Object.freeze({
    version: MANIFEST_VERSION,
    pluginId,
    packageName,
    apiVersion: HOLO_PROJECT_PREPARE_API_VERSION,
    generatedArtifacts: parseOwnedArtifacts(value.generatedArtifacts, 'generatedArtifacts', false),
    managedArtifacts: parseOwnedArtifacts(value.managedArtifacts, 'managedArtifacts', true),
    watch: parseWatch(value.watch),
    ...(frameworkId ? { frameworkId } : {}),
  })
}

async function readManifest(path: string, expectedPluginId: string, expectedPackageName?: string): Promise<OwnershipManifest | undefined> {
  try {
    return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown, expectedPluginId, expectedPackageName)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function normalizeWatch(watch: HoloProjectPrepareWatch | undefined): HoloProjectPrepareWatch {
  return parseWatch(watch)
}

function normalizeDiagnostics(
  diagnostics: unknown,
  plugin: LoadedProjectPreparer,
): readonly HoloProjectPrepareDiagnostic[] {
  if (typeof diagnostics !== 'undefined' && !Array.isArray(diagnostics)) {
    throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', plugin, 'diagnostics must be an array.')
  }
  const normalized = (diagnostics ?? []).map((diagnostic: unknown, index: number) => {
    if (
      !isRecord(diagnostic)
      || (diagnostic.severity !== 'info' && diagnostic.severity !== 'warning')
      || typeof diagnostic.code !== 'string'
      || !diagnostic.code.trim()
      || typeof diagnostic.message !== 'string'
      || !diagnostic.message.trim()
    ) {
      throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', plugin, `diagnostics[${index}] requires info/warning severity, code, and message.`)
    }
    try {
      const source = typeof diagnostic.source === 'undefined' ? undefined : normalizeSource(diagnostic.source, `diagnostics[${index}].source`)
      const hint = optionalString(diagnostic.hint, `diagnostics[${index}].hint`)
      return Object.freeze({
        severity: diagnostic.severity,
        code: diagnostic.code.trim(),
        message: diagnostic.message.trim(),
        ...(source ? { source } : {}),
        ...(hint ? { hint } : {}),
      })
    } catch (error) {
      throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', plugin, error instanceof Error ? error.message : String(error))
    }
  })
  return Object.freeze(normalized.sort((left, right) => left.code.localeCompare(right.code)))
}

function relevantRun(run: HoloProjectPrepareRun, watch: HoloProjectPrepareWatch | undefined): HoloProjectPrepareRun {
  if (run.kind === 'full') {
    return run
  }
  if (!watch) {
    return { kind: 'full', command: 'dev', reason: 'initial' }
  }
  const roots = watch?.roots ?? []
  const excludes = watch.excludes ?? []
  const changes = run.changes.filter((change) => {
    const included = roots.some(root => root === '.' || change.path === root || change.path.startsWith(`${root}/`))
    const excluded = excludes.some(exclude => change.path === exclude || change.path.startsWith(`${exclude}/`))
    return included && !excluded
  })
  return { kind: 'incremental', command: 'dev', changes: Object.freeze(changes) }
}

async function invokePreparer(
  preparer: LoadedProjectPreparer,
  projectRoot: string,
  generatedRoot: string,
  config: NormalizedHoloProjectConfig,
  previous: OwnershipManifest | undefined,
  options: RunPluginPreparationOptions,
): Promise<PreparedSnapshot> {
  const pluginGeneratedRoot = resolve(generatedRoot, preparer.plugin.definition.id)
  const run = relevantRun(options.run, previous?.watch)
  const context = {
    projectRoot,
    generatedRoot,
    pluginGeneratedRoot,
    config,
    ...(options.framework ? { framework: options.framework } : {}),
    plugin: {
      id: preparer.plugin.definition.id,
      ...(preparer.plugin.definition.name ? { name: preparer.plugin.definition.name } : {}),
      packageName: preparer.plugin.packageName,
      packageRoot: preparer.plugin.packageRoot,
    },
    run,
    signal: options.signal ?? new AbortController().signal,
    logger: {
      info: (message: string) => options.writeInfo?.(`[${preparer.plugin.definition.id}] ${message}`),
      warn: (message: string) => options.writeWarning?.(`[${preparer.plugin.definition.id}] ${message}`),
    },
  }

  let result
  try {
    result = await preparer.preparer.prepare(context)
    if (isRecord(result) && result.kind === 'retry-full') {
      if (typeof result.reason !== 'string' || !result.reason.trim()) {
        throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, 'retry-full requires a non-empty reason.')
      }
      if (run.kind !== 'incremental') {
        throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, 'retry-full is valid only after an incremental run.')
      }
      result = await preparer.preparer.prepare({
        ...context,
        run: { kind: 'full', command: 'dev', reason: 'plugin-requested' },
      })
    }
  } catch (error) {
    if (error instanceof HoloProjectPrepareError) {
      throw attributedError(preparer, error.failure)
    }
    throw hostError(
      'HOLO_PLUGIN_PREPARE_EXECUTION_FAILED',
      preparer,
      'The project preparer threw an unstructured error. Throw HoloProjectPrepareError to report a safe structured failure.',
    )
  }

  if (!isRecord(result) || result.kind !== 'prepared') {
    throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, 'prepare() must return a prepared snapshot.')
  }

  const normalizeArtifactInputs = (value: unknown, field: string): readonly Record<string, unknown>[] => {
    if (typeof value === 'undefined') return []
    if (!Array.isArray(value)) throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, `${field} must be an array.`)
    return value.map((artifact, index) => {
      if (!isRecord(artifact)) throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, `${field}[${index}] must be an object.`)
      if (typeof artifact.path !== 'string') throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, `${field}[${index}].path must be a string.`)
      return artifact
    })
  }
  const generatedInputs = normalizeArtifactInputs(result.generatedArtifacts, 'generatedArtifacts')
  const managedInputs = normalizeArtifactInputs(result.managedArtifacts, 'managedArtifacts')
  if (generatedInputs.length + managedInputs.length > MAX_ARTIFACTS) {
    throw hostError('HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED', preparer, `Artifact count exceeds ${MAX_ARTIFACTS}.`)
  }
  if (Array.isArray(result.diagnostics) && result.diagnostics.length > MAX_DIAGNOSTICS) {
    throw hostError('HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED', preparer, `Diagnostic count exceeds ${MAX_DIAGNOSTICS}.`)
  }

  const seen = new Set<string>()
  const seenRelativePaths = new Set<string>()
  let totalBytes = 0
  const normalizeArtifacts = (
    artifacts: typeof generatedInputs,
    root: string,
    managed: boolean,
  ): PreparedArtifact[] => artifacts.map((artifact) => {
    let path
    try {
      path = normalizeArtifactPath(artifact.path as string)
      if (managed) {
        assertManagedPathAllowed(path, ['config/app.ts', 'config/app.mts', 'config/app.js', 'config/app.mjs'])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw hostError(message.startsWith('Protected managed') ? 'HOLO_PLUGIN_PREPARE_PROTECTED_PATH' : 'HOLO_PLUGIN_PREPARE_INVALID_PATH', preparer, message)
    }
    const key = platformPathKey(resolveContainedPath(root, path))
    const relativeKey = platformPathKey(path)
    if (seen.has(key) || seenRelativePaths.has(relativeKey)) {
      throw hostError('HOLO_PLUGIN_PREPARE_DUPLICATE_ARTIFACT', preparer, `Duplicate artifact path: ${path}.`)
    }
    seen.add(key)
    seenRelativePaths.add(relativeKey)
    let contents
    try {
      contents = encodeContents(artifact.contents as HoloProjectArtifactContents)
    } catch (error) {
      throw hostError('HOLO_PLUGIN_PREPARE_INVALID_RESULT', preparer, error instanceof Error ? error.message : String(error))
    }
    if (contents.byteLength > MAX_ARTIFACT_BYTES) {
      throw hostError('HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED', preparer, `Artifact ${path} exceeds ${MAX_ARTIFACT_BYTES} bytes.`)
    }
    totalBytes += contents.byteLength
    return { path, absolutePath: resolveContainedPath(root, path), contents, digest: digest(contents) }
  })

  const generatedArtifacts = normalizeArtifacts(generatedInputs, pluginGeneratedRoot, false)
  const managedArtifacts = normalizeArtifacts(managedInputs, projectRoot, true)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw hostError('HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED', preparer, `Total artifact size exceeds ${MAX_TOTAL_BYTES} bytes.`)
  }

  let watch
  try {
    watch = normalizeWatch(result.watch)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = message.includes('artifact path') || message.startsWith('Watch exclusion')
      ? 'HOLO_PLUGIN_PREPARE_INVALID_PATH'
      : 'HOLO_PLUGIN_PREPARE_INVALID_RESULT'
    throw hostError(code, preparer, message)
  }
  const diagnostics = normalizeDiagnostics(result.diagnostics, preparer)

  return {
    plugin: preparer,
    generatedArtifacts: Object.freeze(generatedArtifacts.sort((left, right) => left.path.localeCompare(right.path))),
    managedArtifacts: Object.freeze(managedArtifacts.sort((left, right) => left.path.localeCompare(right.path))),
    diagnostics,
    watch,
    ...(previous ? { previous } : {}),
    ...(options.framework ? { frameworkId: options.framework.id } : {}),
  }
}

async function currentDigest(path: string): Promise<string | undefined> {
  try {
    return digest(await readFile(path))
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertSnapshotOwnership(snapshot: PreparedSnapshot, projectRoot: string): Promise<void> {
  const previousManaged = new Map(snapshot.previous?.managedArtifacts.map(artifact => [artifact.path, artifact]))
  for (const artifact of snapshot.managedArtifacts) {
    const previous = previousManaged.get(artifact.path)
    const actualDigest = await currentDigest(artifact.absolutePath)
    if (!previous && actualDigest && actualDigest !== artifact.digest) {
      throw hostError('HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT', snapshot.plugin, `Managed artifact already exists and is unowned: ${artifact.path}.`)
    }
    if (previous && actualDigest !== previous.digest && actualDigest !== artifact.digest) {
      throw hostError('HOLO_PLUGIN_PREPARE_MODIFIED_MANAGED_FILE', snapshot.plugin, `Managed artifact was modified by the application: ${artifact.path}.`)
    }
  }

  const desired = new Set(snapshot.managedArtifacts.map(artifact => artifact.path))
  for (const previous of snapshot.previous?.managedArtifacts ?? []) {
    if (desired.has(previous.path)) continue

    const actualDigest = await currentDigest(resolveContainedPath(projectRoot, previous.path))
    if (actualDigest && actualDigest !== previous.digest) {
      throw hostError('HOLO_PLUGIN_PREPARE_MODIFIED_MANAGED_FILE', snapshot.plugin, `Stale managed artifact was modified by the application: ${previous.path}.`)
    }
  }
}

async function stageWrite(path: string, contents: Uint8Array, plugin: LoadedProjectPreparer): Promise<StagedWrite> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.holo-${process.pid}-${randomUUID()}.tmp`
  const handle = await open(temporary, 'w')
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return { target: path, temporary, plugin }
}

async function moveExistingPathToBackup(path: string): Promise<string | undefined> {
  try {
    await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }

  const backup = `${path}.holo-${process.pid}-${randomUUID()}.backup`
  await rename(path, backup)
  return backup
}

async function commitWrite(write: StagedWrite): Promise<CommittedMutation> {
  const backup = await moveExistingPathToBackup(write.target)
  try {
    await rename(write.temporary, write.target)
  } catch (error) {
    if (backup) await rename(backup, write.target)
    throw error
  }

  return {
    async rollback() {
      await rm(write.target, { recursive: true, force: true })
      if (backup) await rename(backup, write.target)
    },
    async finalize() {
      if (backup) await rm(backup, { recursive: true, force: true })
    },
  }
}

async function commitRemoval(removal: PendingRemoval): Promise<CommittedMutation | undefined> {
  const backup = await moveExistingPathToBackup(removal.target)
  if (!backup) return undefined

  return {
    async rollback() {
      await rename(backup, removal.target)
    },
    async finalize() {
      await rm(backup, { recursive: removal.recursive ?? false, force: true })
    },
  }
}

async function rollbackMutations(mutations: readonly CommittedMutation[]): Promise<void> {
  let rollbackError: unknown
  for (const mutation of [...mutations].reverse()) {
    try {
      await mutation.rollback()
    } catch (error) {
      rollbackError ??= error
    }
  }
  if (rollbackError) throw rollbackError
}

async function finalizeMutations(mutations: readonly CommittedMutation[]): Promise<void> {
  for (const mutation of mutations) await mutation.finalize()
}

async function planInactivePluginSnapshots(
  projectRoot: string,
  generatedRoot: string,
  activePluginIds: ReadonlySet<string>,
  activePlugins: readonly LoadedHoloPlugin[],
  writeWarning: RunPluginPreparationOptions['writeWarning'],
): Promise<readonly PendingRemoval[]> {
  const manifestsRoot = resolve(generatedRoot, '.plugins')
  const entries = await readdir(manifestsRoot, { withFileTypes: true }).catch(() => [])
  const removals: PendingRemoval[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const manifestPath = resolve(manifestsRoot, entry.name)
    const expectedPluginId = entry.name.slice(0, -'.json'.length)
    let manifest
    try {
      manifest = await readManifest(manifestPath, expectedPluginId)
    } catch (error) {
      writeWarning?.(`[${expectedPluginId}] Preserved invalid ownership manifest: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (!manifest || activePluginIds.has(manifest.pluginId)) {
      continue
    }

    let modifiedManagedArtifact = false
    for (const artifact of manifest.managedArtifacts) {
      const path = resolveContainedPath(projectRoot, artifact.path)
      const owningPackage = activePlugins.find(plugin => isPathInside(plugin.packageRoot, path))
      if (owningPackage) {
        modifiedManagedArtifact = true
        writeWarning?.(`[${manifest.pluginId}] Preserved managed artifact inside active plugin package ${owningPackage.packageName}: ${artifact.path}`)
        continue
      }
      const actualDigest = await currentDigest(path)
      if (!actualDigest) {
        continue
      }
      if (actualDigest !== artifact.digest) {
        modifiedManagedArtifact = true
        writeWarning?.(`[${manifest.pluginId}] Preserved modified managed artifact after plugin deactivation: ${artifact.path}`)
        continue
      }
      await assertNoSymbolicLinks(projectRoot, path)
      removals.push({ root: projectRoot, target: path })
    }
    const pluginGeneratedRoot = resolveContainedPath(generatedRoot, manifest.pluginId)
    await assertNoSymbolicLinks(projectRoot, pluginGeneratedRoot)
    removals.push({ root: projectRoot, target: pluginGeneratedRoot, recursive: true })
    if (!modifiedManagedArtifact) {
      await assertNoSymbolicLinks(manifestsRoot, manifestPath)
      removals.push({ root: manifestsRoot, target: manifestPath })
    }
  }
  return Object.freeze(removals)
}

async function planSnapshotRemovals(
  snapshot: PreparedSnapshot,
  projectRoot: string,
  generatedRoot: string,
  activePlugins: readonly LoadedHoloPlugin[],
): Promise<readonly PendingRemoval[]> {
  const generatedRootForPlugin = resolve(generatedRoot, snapshot.plugin.plugin.definition.id)
  const removals: PendingRemoval[] = []
  const desiredGenerated = new Set(snapshot.generatedArtifacts.map(artifact => artifact.path))
  for (const previous of snapshot.previous?.generatedArtifacts ?? []) {
    if (!desiredGenerated.has(previous.path)) {
      const target = resolveContainedPath(generatedRootForPlugin, previous.path)
      if (!await currentDigest(target)) continue
      await assertNoSymbolicLinks(projectRoot, target)
      removals.push({ root: projectRoot, target })
    }
  }

  const desiredManaged = new Set(snapshot.managedArtifacts.map(artifact => artifact.path))
  for (const previous of snapshot.previous?.managedArtifacts ?? []) {
    if (desiredManaged.has(previous.path)) {
      continue
    }
    const path = resolveContainedPath(projectRoot, previous.path)
    const owningPackage = activePlugins.find(plugin => isPathInside(plugin.packageRoot, path))
    if (owningPackage) {
      throw hostError('HOLO_PLUGIN_PREPARE_PROTECTED_PATH', snapshot.plugin, `Stale managed artifact targets active plugin package root ${owningPackage.packageName}: ${previous.path}.`)
    }
    const actualDigest = await currentDigest(path)
    if (!actualDigest) continue
    if (actualDigest !== previous.digest) {
      throw hostError('HOLO_PLUGIN_PREPARE_MODIFIED_MANAGED_FILE', snapshot.plugin, `Stale managed artifact was modified by the application: ${previous.path}.`)
    }
    await assertNoSymbolicLinks(projectRoot, path)
    removals.push({ root: projectRoot, target: path })
  }
  return Object.freeze(removals)
}

function snapshotManifestContents(snapshot: PreparedSnapshot): Uint8Array {
  const manifest: OwnershipManifest = {
    version: MANIFEST_VERSION,
    pluginId: snapshot.plugin.plugin.definition.id,
    packageName: snapshot.plugin.plugin.packageName,
    apiVersion: HOLO_PROJECT_PREPARE_API_VERSION,
    generatedArtifacts: snapshot.generatedArtifacts.map(({ path, digest }) => ({ path, digest })),
    managedArtifacts: snapshot.managedArtifacts.map(({ path, digest }) => ({ path, digest })),
    watch: snapshot.watch,
    ...(snapshot.frameworkId ? { frameworkId: snapshot.frameworkId } : {}),
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

async function cleanupAbandonedTemporaryFiles(directories: ReadonlySet<string>): Promise<void> {
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !/\.holo-\d+-[a-f0-9-]+\.tmp$/i.test(entry.name)) continue
      const target = resolve(directory, entry.name)
      await assertNoSymbolicLinks(directory, target)
      await rm(target, { force: true })
    }
  }
}

function renderDiagnostic(diagnostic: HoloProjectPrepareDiagnostic): string {
  const location = diagnostic.source
    ? ` ${diagnostic.source.path}${diagnostic.source.line ? `:${diagnostic.source.line}${diagnostic.source.column ? `:${diagnostic.source.column}` : ''}` : ''}`
    : ''
  return `${diagnostic.code}:${location} ${diagnostic.message}${diagnostic.hint ? `\n  Hint: ${diagnostic.hint}` : ''}`
}

async function runPluginProjectPreparersUnlocked(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  options: RunPluginPreparationOptions,
): Promise<void> {
  const root = resolve(projectRoot)
  const generatedRoot = resolve(root, '.holo-js/generated')
  const pluginPreparation = await loadProjectPluginPreparation(root)
  const preparers = pluginPreparation.preparers
  const preparerIds = new Set<string>()
  for (const preparer of preparers) {
    if (preparerIds.has(preparer.plugin.definition.id)) {
      throw hostError('HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT', preparer, `Duplicate active project preparer plugin ID: ${preparer.plugin.definition.id}.`)
    }
    preparerIds.add(preparer.plugin.definition.id)
  }

  const snapshots: PreparedSnapshot[] = []
  const managedClaims = new Map<string, string>()
  for (const preparer of preparers) {
    const manifestPath = resolve(generatedRoot, '.plugins', `${preparer.plugin.definition.id}.json`)
    let previous
    try {
      previous = await readManifest(manifestPath, preparer.plugin.definition.id, preparer.plugin.packageName)
    } catch (error) {
      throw hostError('HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT', preparer, `Invalid ownership manifest: ${error instanceof Error ? error.message : String(error)}`)
    }
    const snapshot = await invokePreparer(preparer, root, generatedRoot, config, previous, options)
    for (const artifact of snapshot.managedArtifacts) {
      const key = platformPathKey(artifact.absolutePath)
      const existing = managedClaims.get(key)
      if (existing) {
        throw hostError('HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT', preparer, `Managed artifact ${artifact.path} is also claimed by ${existing}.`)
      }
      managedClaims.set(key, preparer.plugin.packageName)
    }
    await assertSnapshotOwnership(snapshot, root)
    snapshots.push(snapshot)
  }

  for (const snapshot of snapshots) {
    for (const artifact of snapshot.managedArtifacts) {
      const owningPackage = pluginPreparation.activePlugins.find(plugin => isPathInside(plugin.packageRoot, artifact.absolutePath))
      if (owningPackage) {
        throw hostError('HOLO_PLUGIN_PREPARE_PROTECTED_PATH', snapshot.plugin, `Managed artifact targets plugin package root ${owningPackage.packageName}: ${artifact.path}.`)
      }
    }
  }

  const removals: PendingRemoval[] = [...await planInactivePluginSnapshots(
    root,
    generatedRoot,
    new Set(preparers.map(preparer => preparer.plugin.definition.id)),
    pluginPreparation.activePlugins,
    options.writeWarning,
  )]
  for (const snapshot of snapshots) {
    for (const artifact of snapshot.generatedArtifacts) {
      await assertNoSymbolicLinkParents(root, artifact.absolutePath)
    }
    for (const artifact of snapshot.managedArtifacts) {
      await assertNoSymbolicLinkParents(root, artifact.absolutePath)
    }
    await assertNoSymbolicLinkParents(root, resolve(generatedRoot, '.plugins', `${snapshot.plugin.plugin.definition.id}.json`))
    removals.push(...await planSnapshotRemovals(snapshot, root, generatedRoot, pluginPreparation.activePlugins))
  }

  const temporaryDirectories = new Set<string>([resolve(generatedRoot, '.plugins')])
  for (const snapshot of snapshots) {
    for (const artifact of [...snapshot.generatedArtifacts, ...snapshot.managedArtifacts]) temporaryDirectories.add(dirname(artifact.absolutePath))
  }
  for (const removal of removals) temporaryDirectories.add(dirname(removal.target))
  await cleanupAbandonedTemporaryFiles(temporaryDirectories)

  const artifactWrites: StagedWrite[] = []
  const manifestWrites: StagedWrite[] = []
  const committedMutations: CommittedMutation[] = []
  let snapshotCommitted = false
  try {
    for (const snapshot of snapshots) {
      for (const artifact of [...snapshot.generatedArtifacts, ...snapshot.managedArtifacts]) {
        options.signal?.throwIfAborted()
        if (await currentDigest(artifact.absolutePath) !== artifact.digest) {
          artifactWrites.push(await stageWrite(artifact.absolutePath, artifact.contents, snapshot.plugin))
        }
      }
      const manifestPath = resolve(generatedRoot, '.plugins', `${snapshot.plugin.plugin.definition.id}.json`)
      const contents = snapshotManifestContents(snapshot)
      if (await currentDigest(manifestPath) !== digest(contents)) {
        manifestWrites.push(await stageWrite(manifestPath, contents, snapshot.plugin))
      }
    }

    for (const write of artifactWrites) {
      options.signal?.throwIfAborted()
      await assertNoSymbolicLinkParents(root, write.target)
      committedMutations.push(await commitWrite(write))
    }
    for (const removal of removals) {
      options.signal?.throwIfAborted()
      await assertNoSymbolicLinks(removal.root, removal.target)
      const mutation = await commitRemoval(removal)
      if (mutation) committedMutations.push(mutation)
    }
    for (const write of manifestWrites) {
      options.signal?.throwIfAborted()
      await assertNoSymbolicLinkParents(root, write.target)
      committedMutations.push(await commitWrite(write))
    }
    snapshotCommitted = true
    await finalizeMutations(committedMutations)
  } catch (error) {
    if (!snapshotCommitted) {
      try {
        await rollbackMutations(committedMutations)
      } catch (rollbackError) {
        const plugin = snapshots[0]?.plugin
        if (!plugin) throw rollbackError
        throw hostError('HOLO_PLUGIN_PREPARE_COMMIT_FAILED', plugin, rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
      }
    }
    const plugin = [...artifactWrites, ...manifestWrites].find(write => write.temporary)
      ?.plugin ?? snapshots[0]?.plugin
    if (error instanceof HoloProjectPrepareError) throw error
    if (!plugin) throw error
    throw hostError('HOLO_PLUGIN_PREPARE_COMMIT_FAILED', plugin, error instanceof Error ? error.message : String(error))
  } finally {
    for (const write of [...artifactWrites, ...manifestWrites]) await rm(write.temporary, { force: true })
  }

  for (const snapshot of snapshots) {
    for (const diagnostic of snapshot.diagnostics) {
      const message = `[${snapshot.plugin.plugin.definition.id}] ${renderDiagnostic(diagnostic)}`
      if (diagnostic.severity === 'warning') options.writeWarning?.(message)
      else options.writeInfo?.(message)
    }
  }
}

export async function runPluginProjectPreparers(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  options: RunPluginPreparationOptions,
): Promise<void> {
  const root = resolve(projectRoot)
  const release = await acquireProjectPrepareLock(root, options.signal)
  try {
    await runPluginProjectPreparersUnlocked(root, config, options)
  } finally {
    await release()
  }
}
