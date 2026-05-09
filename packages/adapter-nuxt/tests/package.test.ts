import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-nuxt package boundaries', () => {
  it('keeps exported storage and forms surfaces as optional peers', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const moduleEntryPath = resolve(import.meta.dirname, '../src/module.ts')
    const runtimeEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/index.ts')
    const storageEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/storage.ts')
    const clientEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/forms.ts')
    const storagePluginPath = resolve(import.meta.dirname, '../src/runtime/plugins/storage.ts')
    const storageRoutePath = resolve(import.meta.dirname, '../src/runtime/server/routes/storage.get.ts')
    const s3DriverPath = resolve(import.meta.dirname, '../src/runtime/drivers/s3.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
      exports?: Record<string, unknown>
    }
    const moduleEntry = await readFile(moduleEntryPath, 'utf8')
    const runtimeEntry = await readFile(runtimeEntryPath, 'utf8')
    const storageEntry = await readFile(storageEntryPath, 'utf8')
    const clientEntry = await readFile(clientEntryPath, 'utf8')
    const storagePlugin = await readFile(storagePluginPath, 'utf8')
    const storageRoute = await readFile(storageRoutePath, 'utf8')
    const s3Driver = await readFile(s3DriverPath, 'utf8')

    expect(moduleEntry).not.toMatch(/@holo-js\/forms/)
    expect(moduleEntry).toMatch(/import\(\s*['"]@holo-js\/storage['"]\s*\)/)
    expect(moduleEntry).toMatch(/import\(\s*['"]@holo-js\/storage-s3['"](?:\s+as\s+string)?\s*\)/)
    expect(runtimeEntry).not.toMatch(/@holo-js\/forms/)
    expect(runtimeEntry).not.toMatch(/@holo-js\/storage\/runtime/)
    expect(storageEntry).toMatch(/@holo-js\/storage\/runtime/)
    expect(clientEntry).toMatch(/@holo-js\/forms\/internal\/client/)
    expect(storagePlugin).toMatch(/@holo-js\/storage\/runtime/)
    expect(storageRoute).toMatch(/@holo-js\/storage/)
    expect(s3Driver).toMatch(/@holo-js\/storage-s3/)
    expect(packageJson.exports?.['./storage']).toBeDefined()
    expect(packageJson.exports?.['./auth']).toBeUndefined()
    expect(packageJson.exports?.['./server']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/storage']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/storage-s3']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/storage']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/storage-s3']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/storage']?.optional).toBe(true)
    expect(packageJson.peerDependenciesMeta?.['@holo-js/storage-s3']?.optional).toBe(true)
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBe(true)
  })
})
