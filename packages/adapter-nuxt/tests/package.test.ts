import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-nuxt package boundaries', () => {
  it('keeps exported storage and forms surfaces as optional peers', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const runtimeEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/index.ts')
    const storageEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/storage.ts')
    const clientEntryPath = resolve(import.meta.dirname, '../src/runtime/composables/forms.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
      exports?: Record<string, unknown>
    }
    const runtimeEntry = await readFile(runtimeEntryPath, 'utf8')
    const storageEntry = await readFile(storageEntryPath, 'utf8')
    const clientEntry = await readFile(clientEntryPath, 'utf8')

    expect(runtimeEntry).not.toContain("@holo-js/storage/runtime")
    expect(storageEntry).toContain("@holo-js/storage/runtime")
    expect(clientEntry).toContain("@holo-js/forms/client")
    expect(packageJson.exports?.['./storage']).toBeDefined()
    expect(packageJson.dependencies?.['@holo-js/storage']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/storage']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/storage']?.optional).toBe(true)
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBe(true)
  })
})
