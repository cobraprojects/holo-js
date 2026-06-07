import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-next package boundaries', () => {
  it('keeps forms client surface optional and leaves auth helpers in @holo-js/auth', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const indexEntryPath = resolve(import.meta.dirname, '../src/index.ts')
    const clientEntryPath = resolve(import.meta.dirname, '../src/client.ts')
    const realtimeEntryPath = resolve(import.meta.dirname, '../src/realtime.ts')
    const runtimeEntryPath = resolve(import.meta.dirname, '../src/runtime.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      exports?: Record<string, unknown>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const indexEntry = await readFile(indexEntryPath, 'utf8')
    const clientEntry = await readFile(clientEntryPath, 'utf8')
    const realtimeEntry = await readFile(realtimeEntryPath, 'utf8')
    const runtimeEntry = await readFile(runtimeEntryPath, 'utf8')

    expect(indexEntry).not.toContain("@holo-js/forms")
    expect(clientEntry).toContain("@holo-js/forms/internal/client")
    expect(clientEntry).not.toContain("@holo-js/auth")
    expect(clientEntry).not.toContain("@holo-js/realtime")
    expect(realtimeEntry).toContain("@holo-js/realtime/client")
    expect(runtimeEntry).not.toContain("@holo-js/forms")
    expect(runtimeEntry).not.toContain("@holo-js/auth")
    expect(packageJson.dependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/realtime']).toBeUndefined()
    expect(packageJson.exports?.['./realtime']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/realtime']).toBeDefined()
    expect(packageJson.peerDependencies?.react).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBe(true)
    expect(packageJson.peerDependenciesMeta?.['@holo-js/realtime']?.optional).toBe(true)
  })
})
