import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

type PackageManifest = {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>
}

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as PackageManifest

describe('@holo-js/kernel manifest', () => {
  it('declares file-type as a runtime dependency because inspectFileContent imports it unconditionally', () => {
    expect(manifest.dependencies?.['file-type']).toBe('catalog:')
  })

  it('does not keep file-type as an optional peer or a dev-only dependency', () => {
    expect(manifest.peerDependencies).not.toHaveProperty('file-type')
    expect(manifest.peerDependenciesMeta).not.toHaveProperty('file-type')
    expect(manifest.devDependencies).not.toHaveProperty('file-type')
  })
})
