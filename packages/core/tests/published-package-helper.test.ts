import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { linkInstalledDependenciesForPackageSync } from '../../../tests/support/published-package'

const repoRoot = resolve(import.meta.dirname, '../../..')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeFixturePackage(manifest: Record<string, unknown>): { nodeModulesRoot: string, packageJsonPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'holo-helper-fixture-'))
  roots.push(root)
  const packageJsonPath = join(root, 'package.json')
  writeFileSync(packageJsonPath, JSON.stringify({ name: '@holo-js/fixture', ...manifest }))
  return { nodeModulesRoot: join(root, 'node_modules'), packageJsonPath }
}

function linked(nodeModulesRoot: string, packageName: string): boolean {
  return lstatSync(join(nodeModulesRoot, ...packageName.split('/')), { throwIfNoEntry: false }) !== undefined
}

describe('published package helper workspace links', () => {
  it('links required workspace peers but not optional ones, and skips optional peers of linked packages', async () => {
    const { nodeModulesRoot, packageJsonPath } = writeFixturePackage({
      dependencies: { '@holo-js/auth': 'catalog:' },
      peerDependencies: { '@holo-js/db': 'catalog:', '@holo-js/security': 'catalog:' },
      peerDependenciesMeta: { '@holo-js/security': { optional: true } },
    })
    linkInstalledDependenciesForPackageSync({ repoRoot, nodeModulesRoot, packageJsonPath })

    expect(linked(nodeModulesRoot, '@holo-js/auth')).toBe(true)
    expect(linked(nodeModulesRoot, '@holo-js/db')).toBe(true)
    expect(linked(nodeModulesRoot, '@holo-js/security')).toBe(false)
    expect(existsSync(join(nodeModulesRoot, '@holo-js', 'kernel'))).toBe(true)
  })
})
