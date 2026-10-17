import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Alias } from 'vite'
import { defineConfig } from 'vitest/config'

type ExportTarget = string | null | { readonly [condition: string]: ExportTarget }

type WorkspaceManifest = {
  readonly name: string
  readonly exports?: Readonly<Record<string, ExportTarget>>
}

const workspaceSourceCondition = '@holo-js/source'
const packagesDirectory = resolve(import.meta.dirname, 'packages')

function nodeSourceEntry(target: ExportTarget): string | null {
  if (!target || typeof target === 'string') return null
  const source = target[workspaceSourceCondition]
  if (typeof source === 'string') return source
  return nodeSourceEntry(target.node ?? target.import ?? target.default ?? null)
}

function escapeSpecifier(specifier: string): string {
  return specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function workspaceSourceAliases(): Alias[] {
  return readdirSync(packagesDirectory).flatMap((directoryName) => {
    const manifestPath = join(packagesDirectory, directoryName, 'package.json')
    if (!existsSync(manifestPath)) return []
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest
    return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
      const source = nodeSourceEntry(target)
      if (!source) return []
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`
      return [{ find: new RegExp(`^${escapeSpecifier(specifier)}$`), replacement: join(packagesDirectory, directoryName, source) }]
    })
  })
}

export const workspaceTestConfig = defineConfig({
  resolve: {
    alias: workspaceSourceAliases(),
  },
})
