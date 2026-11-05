import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeTextFile } from './project/atomic-file'

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
  const contents = await readFile(path).catch(() => undefined)
  return contents ? hashContents(contents) : null
}

async function trackWrites<TResult>(
  paths: readonly string[],
  write: () => Promise<TResult>,
  record: () => Promise<void>,
): Promise<TResult> {
  let release = (): void => {}
  const pending = new Promise<void>((resolvePromise) => { release = resolvePromise })
  for (const path of paths) {
    pendingWrites.set(path, pending)
    writeGenerations.set(path, (writeGenerations.get(path) ?? 0) + 1)
  }
  try {
    return await write()
  } finally {
    await record()
    for (const path of paths) {
      if (pendingWrites.get(path) === pending) pendingWrites.delete(path)
    }
    release()
  }
}

export async function trackOutputWrites<TResult>(paths: readonly string[], write: () => Promise<TResult>): Promise<TResult> {
  const keys = [...new Set(paths.map(path => resolve(path)))]
  return await trackWrites(keys, write, async () => {
    const hashes = await Promise.all(keys.map(readContentHash))
    keys.forEach((key, index) => writtenContentHashes.set(key, hashes[index] ?? null))
  })
}

export async function writeOutputFile(path: string, contents: string): Promise<void> {
  const key = resolve(path)
  await trackWrites([key], () => writeTextFile(key, contents), async () => {
    writtenContentHashes.set(key, hashContents(contents))
  })
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
