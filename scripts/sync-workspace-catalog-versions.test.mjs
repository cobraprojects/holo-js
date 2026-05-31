import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { syncWorkspaceCatalogVersions } from './sync-workspace-catalog-versions.mjs'

let repoRoot

after(async () => {
  if (repoRoot) {
    await rm(repoRoot, { recursive: true, force: true })
  }
})

test('workspace catalog version sync updates package catalog ranges and generated catalog output', async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'holo-catalog-sync-'))
  await mkdir(join(repoRoot, 'packages/auth'), { recursive: true })
  await mkdir(join(repoRoot, 'packages/create-holo-js'), { recursive: true })
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({
    workspaces: {
      catalog: {
        '@holo-js/auth': '^0.1.5',
        'create-holo-js': '^0.1.5',
        eslint: '^9.0.0',
      },
    },
  }, null, 2), 'utf8')
  await writeFile(join(repoRoot, 'packages/auth/package.json'), JSON.stringify({
    name: '@holo-js/auth',
    version: '0.1.6',
  }, null, 2), 'utf8')
  await writeFile(join(repoRoot, 'packages/create-holo-js/package.json'), JSON.stringify({
    name: 'create-holo-js',
    version: '0.1.6',
  }, null, 2), 'utf8')

  await syncWorkspaceCatalogVersions(repoRoot)

  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.workspaces.catalog['@holo-js/auth'], '^0.1.6')
  assert.equal(manifest.workspaces.catalog['create-holo-js'], '^0.1.6')
  assert.equal(manifest.workspaces.catalog.eslint, '^9.0.0')

  const generated = await readFile(join(repoRoot, 'packages/cli/src/generated/workspaceCatalog.ts'), 'utf8')
  assert.ok(generated.includes('"@holo-js/auth": "^0.1.6"'))
  assert.ok(generated.includes('"create-holo-js": "^0.1.6"'))
})
