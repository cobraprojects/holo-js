import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-sveltekit package boundaries', () => {
  it('keeps forms on the client surface and leaves auth helpers in @holo-js/auth', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const indexEntryPath = resolve(import.meta.dirname, '../src/index.ts')
    const clientEntryPath = resolve(import.meta.dirname, '../src/client.ts')
    const transportEntryPath = resolve(import.meta.dirname, '../src/transport.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const indexEntry = await readFile(indexEntryPath, 'utf8')
    const clientEntry = await readFile(clientEntryPath, 'utf8')
    const transportEntry = await readFile(transportEntryPath, 'utf8')

    expect(indexEntry).toContain("@holo-js/forms/schema")
    expect(indexEntry).not.toContain("@holo-js/forms/internal/client")
    expect(clientEntry).toContain("@holo-js/forms/internal/client")
    expect(clientEntry).not.toContain("@holo-js/forms/client")
    expect(clientEntry).not.toContain("@holo-js/auth")
    expect(transportEntry).not.toContain("@holo-js/forms")
    expect(transportEntry).not.toContain("@holo-js/auth")
    expect(packageJson.dependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/auth']).toBeUndefined()
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBeUndefined()
  })
})
