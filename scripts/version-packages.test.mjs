import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { versionPackages } from './version-packages.mjs'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, {
    recursive: true,
    force: true,
  })))
})

async function createTempRepo() {
  const root = await mkdtemp(join(tmpdir(), 'holo-version-packages-'))
  tempRoots.push(root)
  await mkdir(join(root, 'packages/core'), { recursive: true })
  await mkdir(join(root, 'packages/app'), { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    workspaces: {
      catalog: {
        '@holo-js/app': '^0.2.6',
        '@holo-js/core': '^0.2.6',
      },
    },
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, 'packages/core/package.json'), `${JSON.stringify({
    name: '@holo-js/core',
    version: '0.2.6',
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(root, 'packages/app/package.json'), `${JSON.stringify({
    name: '@holo-js/app',
    version: '0.2.6',
    dependencies: {
      '@holo-js/core': 'catalog:',
    },
    peerDependencies: {
      '@holo-js/core': 'catalog:',
    },
  }, null, 2)}\n`, 'utf8')

  return root
}

test('versioning resolves catalog ranges and preserves versioned manifests', async () => {
  const root = await createTempRepo()

  await versionPackages({
    root,
    runChangeset: async () => {
      const appPath = join(root, 'packages/app/package.json')
      const appManifest = JSON.parse(await readFile(appPath, 'utf8'))
      assert.equal(appManifest.dependencies['@holo-js/core'], '^0.2.6')
      assert.equal(appManifest.peerDependencies['@holo-js/core'], '*')
      appManifest.version = '0.2.7'
      appManifest.dependencies['@holo-js/core'] = '^0.2.7'
      await writeFile(appPath, `${JSON.stringify(appManifest, null, 2)}\n`, 'utf8')

      const corePath = join(root, 'packages/core/package.json')
      const coreManifest = JSON.parse(await readFile(corePath, 'utf8'))
      coreManifest.version = '0.2.7'
      await writeFile(corePath, `${JSON.stringify(coreManifest, null, 2)}\n`, 'utf8')
    },
  })

  const appManifest = JSON.parse(await readFile(join(root, 'packages/app/package.json'), 'utf8'))
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(appManifest.version, '0.2.7')
  assert.equal(appManifest.dependencies['@holo-js/core'], 'catalog:')
  assert.equal(appManifest.peerDependencies['@holo-js/core'], 'catalog:')
  assert.equal(rootManifest.workspaces.catalog['@holo-js/app'], '^0.2.7')
  assert.equal(rootManifest.workspaces.catalog['@holo-js/core'], '^0.2.7')
})

test('versioning restores package manifests when Changesets fails', async () => {
  const root = await createTempRepo()
  const appPath = join(root, 'packages/app/package.json')
  const originalManifest = await readFile(appPath, 'utf8')

  await assert.rejects(
    versionPackages({
      root,
      runChangeset: async () => {
        const manifest = JSON.parse(await readFile(appPath, 'utf8'))
        manifest.version = '0.2.7'
        await writeFile(appPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        throw new Error('version failed')
      },
    }),
    /version failed/,
  )

  assert.equal(await readFile(appPath, 'utf8'), originalManifest)
})
