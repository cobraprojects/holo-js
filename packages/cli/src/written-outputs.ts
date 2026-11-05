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
  readonly hash?: string | null
}

type WrittenOutputLedger = {
  readonly entries: Map<string, LedgerEntry>
  readonly pendingWrites: Map<string, Promise<void>>
}

const WRITTEN_OUTPUT_LEDGER = Symbol.for('holo-js.cli.written-outputs')

const { entries, pendingWrites } = ((globalThis as typeof globalThis & { [WRITTEN_OUTPUT_LEDGER]?: WrittenOutputLedger })[WRITTEN_OUTPUT_LEDGER] ??= {
  entries: new Map(),
  pendingWrites: new Map(),
})

function resolvePackageManifestPaths(projectRoot: string): string[] {
  return [...PACKAGE_MANIFEST_DISCOVERY_PATHS].map(manifest => resolve(join(projectRoot, manifest)))
}

function hashContents(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function readContentHash(path: string): Promise<string | null> {
  try {
    return hashContents(await readFile(path))
  } catch (error) {
    if (!hasErrorCode(error, 'EISDIR')) return null
    const stats = await stat(path).catch(() => undefined)
    return stats ? `directory:${stats.dev}:${stats.ino}:${stats.birthtimeMs}` : null
  }
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

function setEntry(key: string, entry: LedgerEntry): void {
  entries.delete(key)
  entries.set(key, entry)
  for (const candidate of entries.keys()) {
    if (entries.size <= MAX_LEDGER_ENTRIES) break
    if (!pendingWrites.has(candidate)) entries.delete(candidate)
  }
}

async function trackWrites<TResult>(
  paths: readonly string[],
  write: () => Promise<TResult>,
  writtenContents?: (key: string) => string | undefined,
): Promise<TResult> {
  let release = (): void => {}
  const pending = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const keys: string[] = []
  const markPending = (key: string): void => {
    if (keys.includes(key)) return
    keys.push(key)
    pendingWrites.set(key, pending)
    setEntry(key, { hash: entries.get(key)?.hash })
  }
  const requested = paths.map(path => resolve(path))
  requested.forEach(markPending)
  const recorded: string[] = []
  try {
    const targets = await Promise.all(requested.map(path => resolveTrackedPath(path)))
    targets.forEach(markPending)
    recorded.push(...targets)
    const ancestors = (await Promise.all(targets.map(findMissingAncestors))).flat()
    ancestors.forEach(markPending)
    recorded.push(...ancestors)
    return await write()
  } finally {
    const hashes = await Promise.all(recorded.map(async (key) => {
      const contents = writtenContents?.(key)
      return contents === undefined ? await readContentHash(key) : hashContents(contents)
    }))
    recorded.forEach((key, index) => setEntry(key, { hash: hashes[index] ?? null }))
    for (const key of keys) {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
      if (!recorded.includes(key) && entries.get(key)?.hash === undefined) entries.delete(key)
    }
    release()
  }
}

export async function trackOutputWrites<TResult>(paths: readonly string[], write: () => Promise<TResult>): Promise<TResult> {
  return await trackWrites(paths, write)
}

export async function writeOutputFile(path: string, contents: string): Promise<void> {
  let target: string | undefined
  await trackWrites([path], async () => {
    target = await resolveTrackedPath(path)
    await atomicFileInternals.writeTextFile(path, contents)
  }, key => key === target ? contents : undefined)
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
    if (entry?.hash === undefined) return false
    const current = await readContentHash(key)
    if (pendingWrites.has(key) || entries.get(key) !== entry) continue
    if (current === entry.hash) return true
    entries.delete(key)
    return false
  }
}
