import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

test('project manifest swaps never expose a partially written package.json', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'holo-local-install-atomic-'))
  const projectRoot = join(tempRoot, 'project')
  const stagingRoot = join(tempRoot, 'packages')
  const manifestPath = join(projectRoot, 'package.json')
  const originalContents = `${JSON.stringify({ dependencies: { '@holo-js/core': '^0.3.9' } }, null, 2)}\n`

  try {
    await mkdir(projectRoot, { recursive: true })
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(manifestPath, originalContents)
    await writeFile(join(stagingRoot, 'workspace-packages.json'), `${JSON.stringify({
      '@holo-js/core': join(stagingRoot, 'core'),
    })}\n`)

    // A reader that opened package.json before a swap keeps the complete previous file
    // only when the swap renames a fresh file into place instead of truncating in place.
    const beforeActivate = await open(manifestPath, 'r')
    try {
      await activateLocalWorkspacePackages(projectRoot, stagingRoot)
      assert.equal(await beforeActivate.readFile('utf8'), originalContents)
    } finally {
      await beforeActivate.close()
    }

    const activatedContents = await readFile(manifestPath, 'utf8')
    const beforeRestore = await open(manifestPath, 'r')
    try {
      await restoreProjectManifest(projectRoot)
      assert.equal(await beforeRestore.readFile('utf8'), activatedContents)
    } finally {
      await beforeRestore.close()
    }

    assert.equal(await readFile(manifestPath, 'utf8'), originalContents)
    assert.deepEqual((await readdir(projectRoot)).sort(), ['package.json'])
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

test('scaffold overlays retain staged declarations when workspace output changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-staged-overlay-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: { catalog: {} } }))
    const packageRoot = join(root, 'packages', 'queue')
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@holo-js/queue', version: '0.3.20', files: ['dist'],
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
    }))
    const declaration = 'export declare const stagedQueue: true\n'
    await writeFile(join(packageRoot, 'dist', 'index.d.ts'), declaration)
    await writeFile(join(packageRoot, 'dist', 'index.mjs'), 'export const stagedQueue = true\n')
    const stagingRoot = await stageLocalWorkspacePackages(root, join(root, 'staged'))
    await rm(join(packageRoot, 'dist', 'index.d.ts'))
    const projectRoot = join(root, 'project')
    await mkdir(projectRoot)
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/queue': '0.3.20' } }))
    await promisify(execFile)(process.execPath, [
      join(import.meta.dirname, 'validate-scaffold-user-journey-smoke.mjs'), '--overlay-local-packages', projectRoot,
    ], { env: { ...process.env, HOLO_LOCAL_PACKAGES_ROOT: stagingRoot } })
    assert.equal(await readFile(join(projectRoot, 'node_modules', '@holo-js', 'queue', 'dist', 'index.d.ts'), 'utf8'), declaration)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
