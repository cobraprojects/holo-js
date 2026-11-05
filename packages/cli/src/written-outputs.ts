import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const PACKAGE_MANIFEST_DISCOVERY_PATHS = new Set([
  'package.json',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

const writtenContentHashes = new Map<string, string>()

function hashContents(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function readContentHash(path: string): Promise<string | undefined> {
  const contents = await readFile(path).catch(() => undefined)
  return contents && hashContents(contents)
}

export function recordWrittenOutput(path: string, contents: string | Uint8Array): void {
  writtenContentHashes.set(resolve(path), hashContents(contents))
}

export async function recordWrittenPackageManifests(projectRoot: string): Promise<void> {
  await Promise.all([...PACKAGE_MANIFEST_DISCOVERY_PATHS].map(async (manifest) => {
    const path = resolve(join(projectRoot, manifest))
    const hash = await readContentHash(path)
    if (hash) writtenContentHashes.set(path, hash)
    else writtenContentHashes.delete(path)
  }))
}

export async function isUnchangedWrittenOutput(path: string): Promise<boolean> {
  const recorded = writtenContentHashes.get(resolve(path))
  return recorded !== undefined && recorded === await readContentHash(path)
}
