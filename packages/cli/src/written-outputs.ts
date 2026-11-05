import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { atomicFileInternals } from '@holo-js/core'

export const PACKAGE_MANIFEST_DISCOVERY_PATHS = new Set([
  'package.json',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

type WrittenOutputLedger = {
  readonly writtenContentHashes: Map<string, string | null>
  readonly pendingWrites: Map<string, Promise<void>>
  readonly writeGenerations: Map<string, number>
}

const WRITTEN_OUTPUT_LEDGER = Symbol.for('holo-js.cli.written-outputs')
const DIRECTORY_CONTENT = 'directory'

const ledger = ((globalThis as typeof globalThis & { [WRITTEN_OUTPUT_LEDGER]?: WrittenOutputLedger })[WRITTEN_OUTPUT_LEDGER] ??= {
  writtenContentHashes: new Map(),
  pendingWrites: new Map(),
  writeGenerations: new Map(),
})
const { writtenContentHashes, pendingWrites, writeGenerations } = ledger

function resolvePackageManifestPaths(projectRoot: string): string[] {
  return [...PACKAGE_MANIFEST_DISCOVERY_PATHS].map(manifest => resolve(join(projectRoot, manifest)))
}

function hashContents(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function readContentHash(path: string): Promise<string | null> {
  try {
    return hashContents(await readFile(path))
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EISDIR' ? DIRECTORY_CONTENT : null
  }
}

async function findMissingAncestors(path: string): Promise<string[]> {
  const missing: string[] = []
  for (let directory = dirname(path); directory !== dirname(directory); directory = dirname(directory)) {
    if (await lstat(directory).then(() => true, () => false)) break
    missing.push(directory)
  }
  return missing
}

async function trackWrites<TResult>(
  paths: readonly string[],
  write: () => Promise<TResult>,
  writtenContents: ReadonlyMap<string, string> = new Map(),
): Promise<TResult> {
  let release = (): void => {}
  const pending = new Promise<void>((resolvePromise) => { release = resolvePromise })
  const markPending = (key: string): void => {
    pendingWrites.set(key, pending)
    writeGenerations.set(key, (writeGenerations.get(key) ?? 0) + 1)
  }
  const targets = [...new Set(paths.map(path => resolve(path)))]
  targets.forEach(markPending)
  const keys = [...targets]
  try {
    const ancestors = (await Promise.all(targets.map(findMissingAncestors))).flat()
    for (const ancestor of new Set(ancestors)) {
      if (keys.includes(ancestor)) continue
      markPending(ancestor)
      keys.push(ancestor)
    }
    return await write()
  } finally {
    const hashes = await Promise.all(keys.map(async (key) => {
      const contents = writtenContents.get(key)
      return contents === undefined ? await readContentHash(key) : hashContents(contents)
    }))
    keys.forEach((key, index) => writtenContentHashes.set(key, hashes[index] ?? null))
    for (const key of keys) {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key)
    }
    release()
  }
}

export async function trackOutputWrites<TResult>(paths: readonly string[], write: () => Promise<TResult>): Promise<TResult> {
  return await trackWrites(paths, write)
}

export async function writeOutputFile(path: string, contents: string): Promise<void> {
  const key = resolve(path)
  await trackWrites([key], () => atomicFileInternals.writeTextFile(key, contents), new Map([[key, contents]]))
}

export async function trackPackageManifestWrites<TResult>(projectRoot: string, write: () => Promise<TResult>): Promise<TResult> {
  return await trackOutputWrites(resolvePackageManifestPaths(projectRoot), write)
}

export async function isUnchangedWrittenOutput(path: string): Promise<boolean> {
  const key = resolve(path)
  for (;;) {
    const pending = pendingWrites.get(key)
    if (pending) {
      await pending
      continue
    }
    const generation = writeGenerations.get(key)
    const recorded = writtenContentHashes.get(key)
    if (recorded === undefined) return false
    const current = await readContentHash(key)
    if (pendingWrites.has(key) || writeGenerations.get(key) !== generation) continue
    if (current === recorded) return true
    if (writtenContentHashes.get(key) === recorded) writtenContentHashes.delete(key)
    return false
  }
}
