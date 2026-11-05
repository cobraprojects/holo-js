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

const writtenContentHashes = new Map<string, string>()
const pendingWrites = new Map<string, Promise<void>>()

function resolvePackageManifestPaths(projectRoot: string): string[] {
  return [...PACKAGE_MANIFEST_DISCOVERY_PATHS].map(manifest => resolve(join(projectRoot, manifest)))
}

function hashContents(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function readContentHash(path: string): Promise<string | undefined> {
  const contents = await readFile(path).catch(() => undefined)
  return contents && hashContents(contents)
}

async function recordWrittenFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async (path) => {
    const hash = await readContentHash(path)
    if (hash) writtenContentHashes.set(path, hash)
    else writtenContentHashes.delete(path)
  }))
}

async function trackWrites<TResult>(
  paths: readonly string[],
  write: () => Promise<TResult>,
  record: () => Promise<void>,
): Promise<TResult> {
  let release = (): void => {}
  const pending = new Promise<void>((resolvePromise) => { release = resolvePromise })
  for (const path of paths) pendingWrites.set(path, pending)
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

export async function writeOutputFile(path: string, contents: string): Promise<void> {
  const key = resolve(path)
  await trackWrites([key], () => writeTextFile(key, contents), async () => {
    writtenContentHashes.set(key, hashContents(contents))
  })
}

export async function trackPackageManifestWrites<TResult>(projectRoot: string, write: () => Promise<TResult>): Promise<TResult> {
  const paths = resolvePackageManifestPaths(projectRoot)
  return await trackWrites(paths, write, () => recordWrittenFiles(paths))
}

export async function isUnchangedWrittenOutput(path: string): Promise<boolean> {
  const key = resolve(path)
  await pendingWrites.get(key)
  const recorded = writtenContentHashes.get(key)
  if (recorded === undefined) return false
  if (recorded === await readContentHash(key)) return true
  if (writtenContentHashes.get(key) === recorded) writtenContentHashes.delete(key)
  return false
}
