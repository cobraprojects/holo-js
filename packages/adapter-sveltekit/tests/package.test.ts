import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('@holo-js/adapter-sveltekit package boundaries', () => {
  it('keeps the forms client surface as an optional peer', async () => {
    const packageJsonPath = resolve(import.meta.dirname, '../package.json')
    const clientEntryPath = resolve(import.meta.dirname, '../src/client.ts')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const clientEntry = await readFile(clientEntryPath, 'utf8')

    expect(clientEntry).toContain("@holo-js/forms/client")
    expect(packageJson.dependencies?.['@holo-js/forms']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@holo-js/forms']).toBeDefined()
    expect(packageJson.peerDependenciesMeta?.['@holo-js/forms']?.optional).toBe(true)
  })
})
