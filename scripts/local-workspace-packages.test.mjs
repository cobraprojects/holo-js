import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  activateLocalWorkspacePackages,
  resolveLocalInstallManifest,
  restoreProjectManifest,
  stageLocalWorkspacePackages,
} from './local-workspace-packages.mjs'

test('local install manifests use staged workspace dependencies for runtime and peer resolution', () => {
  const packageRoot = join(tmpdir(), 'holo-local-core')
  const localPackageRoots = new Map([['@holo-js/core', packageRoot]])
  const manifest = resolveLocalInstallManifest({
    dependencies: {
      '@holo-js/core': 'catalog:',
      esbuild: 'catalog:',
    },
    peerDependencies: {
      '@holo-js/core': 'catalog:',
    },
  }, {
    '@holo-js/core': '^0.3.9',
    esbuild: '^0.27.4',
  }, localPackageRoots)

  assert.equal(manifest.dependencies['@holo-js/core'], pathToFileURL(packageRoot).href)
  assert.equal(manifest.dependencies.esbuild, '^0.27.4')
  assert.equal(manifest.peerDependencies['@holo-js/core'], pathToFileURL(packageRoot).href)
})

test('project manifests use local packages only during dependency installation', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'holo-local-install-'))
  const projectRoot = join(tempRoot, 'project')
  const stagingRoot = join(tempRoot, 'packages')
  const packageRoot = join(stagingRoot, 'core')
  const originalManifest = {
    dependencies: {
      '@holo-js/core': '^0.3.9',
      esbuild: '^0.27.4',
    },
  }

  try {
    await mkdir(projectRoot, { recursive: true })
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(join(projectRoot, 'package.json'), `${JSON.stringify(originalManifest, null, 2)}\n`)
    await writeFile(join(stagingRoot, 'workspace-packages.json'), `${JSON.stringify({
      '@holo-js/core': packageRoot,
    })}\n`)
    await activateLocalWorkspacePackages(projectRoot, stagingRoot)

    const activated = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
    assert.equal(activated.dependencies['@holo-js/core'], pathToFileURL(packageRoot).href)
    assert.equal(activated.dependencies.esbuild, '^0.27.4')

    await restoreProjectManifest(projectRoot)
    assert.deepEqual(
      JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')),
      originalManifest,
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})


test('packed local manifests preserve publishing ranges outside archive substitutions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-local-archives-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: { catalog: {
      '@holo-js/core': '^0.3.16',
    } } }))
    for (const name of ['core', 'consumer']) {
      const directory = join(root, 'packages', name)
      await mkdir(join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'dist', 'index.mjs'), 'export const value = 1\n')
      const manifest = {
        name: `@holo-js/${name}`,
        version: '0.3.16',
        files: ['dist'],
        ...(name === 'consumer' ? {
          dependencies: { '@holo-js/core': 'workspace:*' },
          peerDependencies: { '@holo-js/core': 'catalog:' },
          optionalDependencies: { '@holo-js/core': 'workspace:*' },
          devDependencies: { '@holo-js/core': 'workspace:*' },
        } : {}),
      }
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
    }
    const staging = await stageLocalWorkspacePackages(root, join(root, 'staged'))
    const archive = join(staging, 'holo-js-consumer-0.3.16.tgz')
    const { stdout } = await promisify(execFile)('tar', ['-xOf', archive, 'package/package.json'])
    const manifest = JSON.parse(stdout)
    const coreArchive = pathToFileURL(join(staging, 'holo-js-core-0.3.16.tgz')).href
    assert.deepEqual(manifest.dependencies, { '@holo-js/core': coreArchive })
    assert.deepEqual(manifest.peerDependencies, { '@holo-js/core': coreArchive })
    assert.deepEqual(manifest.optionalDependencies, { '@holo-js/core': coreArchive })
    assert.deepEqual(manifest.devDependencies, { '@holo-js/core': '^0.3.16' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
