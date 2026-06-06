import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-sveltekit package boundaries', () => {
  it('keeps forms on the client surface and leaves auth helpers in @holo-js/auth', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const indexEntryPath = resolve(import.meta.dirname, '../src/index.ts')
    const configEntryPath = resolve(import.meta.dirname, '../src/config.ts')
    const clientEntryPath = resolve(import.meta.dirname, '../src/client.ts')
    const realtimeEntryPath = resolve(import.meta.dirname, '../src/realtime.ts')
    const transportEntryPath = resolve(import.meta.dirname, '../src/transport.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      exports?: Record<string, unknown>
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const indexEntry = await readFile(indexEntryPath, 'utf8')
    const configEntry = await readFile(configEntryPath, 'utf8')
    const clientEntry = await readFile(clientEntryPath, 'utf8')
    const realtimeEntry = await readFile(realtimeEntryPath, 'utf8')
    const transportEntry = await readFile(transportEntryPath, 'utf8')

    expect(indexEntry).toContain("@holo-js/forms/schema")
    expect(indexEntry).not.toContain("@holo-js/forms/internal/client")
    expect(configEntry).not.toContain("@holo-js/forms")
    expect(clientEntry).toContain("@holo-js/forms/internal/client")
    expect(clientEntry).not.toContain("@holo-js/forms/client")
    expect(clientEntry).not.toContain("@holo-js/auth")
    expect(clientEntry).not.toContain("@holo-js/realtime")
    expect(realtimeEntry).toContain("@holo-js/realtime/client")
    expect(transportEntry).not.toContain("@holo-js/forms")
    expect(transportEntry).not.toContain("@holo-js/auth")
    expect(packageJson.dependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.exports?.['./config']).toBeDefined()
    expect(packageJson.exports?.['./realtime']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/realtime']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependencies?.['@holo-js/realtime']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBe(true)
    expect(packageJson.peerDependenciesMeta?.['@holo-js/realtime']?.optional).toBe(true)
  })
})
