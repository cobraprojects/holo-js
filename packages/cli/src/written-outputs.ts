import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { atomicFileInternals } from '@holo-js/core'

export const PACKAGE_MANIFEST_DISCOVERY_PATHS = new Set([
  'package.json',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

const MAX_LEDGER_ENTRIES = 10_000
const MAX_SYMBOLIC_LINK_HOPS = 40

type LedgerEntry = {
  readonly fingerprint?: string | null
}

type WrittenOutputLedger = {
  readonly entries: Map<string, LedgerEntry>
  readonly pendingWrites: Map<string, Promise<void>>
  recordings: number
}

const WRITTEN_OUTPUT_LEDGER = Symbol.for('holo-js.cli.written-outputs')

const ledger = (globalThis as typeof globalThis & { [WRITTEN_OUTPUT_LEDGER]?: WrittenOutputLedger })[WRITTEN_OUTPUT_LEDGER] ??= {
  entries: new Map(),
  pendingWrites: new Map(),
  recordings: 0,
}
const { entries, pendingWrites } = ledger

export function startRecordingWrittenOutputs(): () => void {
  ledger.recordings++
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    ledger.recordings--
  }
}

function resolvePackageManifestPaths(projectRoot: string): string[] {
  return [...PACKAGE_MANIFEST_DISCOVERY_PATHS].map(manifest => resolve(join(projectRoot, manifest)))
}

function hashContents(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

type Fingerprint = {
  readonly content: string | null
  readonly identity: string | null
}

async function readFingerprint(path: string, writtenContents?: string | Uint8Array): Promise<Fingerprint> {
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return { content: null, identity: null }
  if (stats.isDirectory()) {
    const identity = `directory:${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
    return { content: identity, identity }
  }
  const content = writtenContents === undefined
    ? await readFile(path).then(hashContents, (error: unknown) => hasErrorCode(error, 'ENOENT') ? null : '')
    : hashContents(writtenContents)
  if (content === null) return { content: null, identity: null }
  return { content, identity: `file:${content}:${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}` }
}

async function resolveTrackedPath(path: string, hops = 0): Promise<string> {
  const absolute = resolve(path)
  const real = await realpath(absolute).catch(() => undefined)
  if (real) return real
  if (hops < MAX_SYMBOLIC_LINK_HOPS) {
    const link = await readlink(absolute).catch(() => undefined)
    if (link !== undefined) return await resolveTrackedPath(resolve(dirname(absolute), link), hops + 1)
  }
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(await resolveTrackedPath(parent, hops), basename(absolute))
}

async function findMissingAncestors(path: string): Promise<string[]> {
  const missing: string[] = []
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
    if (await lstat(directory).then(() => true, () => false)) break
    missing.push(directory)
  }
  return missing
}

function trimEntries(): void {
  for (const candidate of entries.keys()) {
    if (entries.size <= MAX_LEDGER_ENTRIES) break
    if (!pendingWrites.has(candidate)) entries.delete(candidate)
  }
}

function setEntry(key: string, entry: LedgerEntry): void {
  entries.delete(key)
  entries.set(key, entry)
  trimEntries()
}

async function trackWrites<TResult>(
  paths: readonly string[],
  write: () => Promise<TResult>,
  writtenContents?: (key: string) => string | Uint8Array | undefined,
  ancestorPaths: readonly string[] = paths,
  ownsContentChanges = true,
): Promise<TResult> {
  if (ledger.recordings === 0) return await write()
  let release = (): void => {}
  const pending = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const keys: string[] = []
  const previousFingerprints = new Map<string, string | null | undefined>()
  const markPending = (key: string): void => {
    if (keys.includes(key)) return
    keys.push(key)
    previousFingerprints.set(key, entries.get(key)?.fingerprint)
    pendingWrites.set(key, pending)
    setEntry(key, { fingerprint: entries.get(key)?.fingerprint })
  }
  const requested = paths.map(path => resolve(path))
  requested.forEach(markPending)
  const recorded: string[] = []
  const fingerprintsBefore = new Map<string, Fingerprint>()
  try {
    const targets = await Promise.all(requested.map(path => resolveTrackedPath(path)))
    targets.forEach(markPending)
    recorded.push(...targets)
    const ancestorTargets = await Promise.all(ancestorPaths.map(path => resolveTrackedPath(path)))
    const ancestors = (await Promise.all(ancestorTargets.map(findMissingAncestors))).flat()
    ancestors.forEach(markPending)
    recorded.push(...ancestors)
    await Promise.all(recorded.map(async (key) => {
      if (writtenContents?.(key) === undefined) fingerprintsBefore.set(key, await readFingerprint(key))
    }))
    return await write()
  } finally {
    const fingerprints = await Promise.all(recorded.map(key => readFingerprint(key, writtenContents?.(key))))
    recorded.forEach((key, index) => {
      const after = fingerprints[index] ?? { content: null, identity: null }
      const before = fingerprintsBefore.get(key)
      const previous = previousFingerprints.get(key)
      const keepPrevious = before !== undefined && (before.content === after.content
        ? before.identity !== previous
        : !ownsContentChanges)
      setEntry(key, { fingerprint: keepPrevious ? previous : after.identity })
    })
    for (const key of keys) {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
      if (entries.get(key)?.fingerprint === undefined) entries.delete(key)
    }
    trimEntries()
    release()
  }
}

export async function trackOutputWrites<TResult>(paths: readonly string[], write: () => Promise<TResult>): Promise<TResult> {
  return await trackWrites(paths, write)
}

export async function trackOutputWrite<TResult>(path: string, contents: string | Uint8Array, write: () => Promise<TResult>): Promise<TResult> {
  let target: string | undefined
  return await trackWrites([path], async () => {
    target = await resolveTrackedPath(path)
    return await write()
  }, key => key === target ? contents : undefined)
}

export async function trackOutputDirectories<TResult>(path: string, write: () => Promise<TResult>): Promise<TResult> {
  return await trackWrites([], write, undefined, [path])
}

export async function writeOutputFile(path: string, contents: string): Promise<void> {
  await trackOutputWrite(path, contents, () => atomicFileInternals.writeTextFile(path, contents))
}

export async function recordPackageManifestBaseline(projectRoot: string): Promise<void> {
  if (ledger.recordings === 0) return
  await Promise.all(resolvePackageManifestPaths(projectRoot).map(async (path) => {
    const key = await resolveTrackedPath(path)
    const { identity } = await readFingerprint(key)
    if (!pendingWrites.has(key)) setEntry(key, { fingerprint: identity })
  }))
}

export async function trackPackageManifestRestores<TResult>(projectRoot: string, write: () => Promise<TResult>): Promise<TResult> {
  const paths = resolvePackageManifestPaths(projectRoot)
  return await trackWrites(paths, write, undefined, paths, false)
}

export async function trackPackageManifestWrites<TResult>(projectRoot: string, write: () => Promise<TResult>): Promise<TResult> {
  return await trackOutputWrites(resolvePackageManifestPaths(projectRoot), write)
}

export async function isUnchangedWrittenOutput(path: string): Promise<boolean> {
  await pendingWrites.get(resolve(path))
  const key = await resolveTrackedPath(path)
  for (;;) {
    const pending = pendingWrites.get(key)
    if (pending) {
      await pending
      continue
    }
    const entry = entries.get(key)
    if (entry?.fingerprint === undefined) return false
    const { identity } = await readFingerprint(key)
    if (pendingWrites.has(key) || entries.get(key) !== entry) continue
    if (identity === entry.fingerprint) return true
    entries.delete(key)
    return false
  }
}
