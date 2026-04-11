import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/core package boundaries', () => {
  it('keeps queue and storage support optional in the published surface', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const runtimeTypesPath = resolve(import.meta.dirname, '../src/runtime/index.d.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const runtimeTypes = await readFile(runtimeTypesPath, 'utf8')

    expect(runtimeTypes).not.toContain("from '@holo-js/queue'")
    expect(runtimeTypes).not.toContain('ReadonlyMap<string, unknown>')
    expect(runtimeTypes).toContain("readonly mode: 'async' | 'sync';")
    expect(runtimeTypes).toContain('readonly driver: string;')
    const optionalRuntimePackages = [
      '@holo-js/auth',
      '@holo-js/auth-clerk',
      '@holo-js/auth-social',
      '@holo-js/auth-workos',
      '@holo-js/queue',
      '@holo-js/session',
      '@holo-js/storage',
    ] as const

    for (const packageName of optionalRuntimePackages) {
      expect(packageJson.dependencies?.[packageName]).toBeUndefined()
      expect(packageJson.peerDependencies?.[packageName]).toBeDefined()
      expect(packageJson.peerDependenciesMeta?.[packageName]?.optional).toBe(true)
    }
  })
})
