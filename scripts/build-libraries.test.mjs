import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectLibraryBuilds } from './build-libraries.mjs'

async function createWorkspace(context, manifests) {
  const root = await mkdtemp(join(tmpdir(), 'holo-library-builds-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  for (const manifest of manifests) {
    const directory = join(root, 'packages', manifest.name.split('/').at(-1))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { build: 'tsup' }, ...manifest }))
  }
  return root
}

test('builds all libraries after their catalog, optional, and peer dependencies, once each', async (context) => {
  const root = await createWorkspace(context, [
    { name: '@holo-js/adapter', dependencies: { '@holo-js/config': 'catalog:', external: '^1.0.0' }, peerDependencies: { '@holo-js/auth': 'catalog:' } },
    { name: '@holo-js/auth', optionalDependencies: { '@holo-js/config': 'catalog:' } },
    { name: '@holo-js/config', dependencies: { '@holo-js/kernel': 'catalog:' } },
    { name: '@holo-js/kernel' },
    { name: '@holo-js/unused-by-docs' },
  ])
  assert.deepEqual(collectLibraryBuilds(root).map(build => build.name), [
    '@holo-js/kernel',
    '@holo-js/config',
    '@holo-js/auth',
    '@holo-js/adapter',
    '@holo-js/unused-by-docs',
  ])
})

test('rejects circular library dependencies before building', async (context) => {
  const root = await createWorkspace(context, [
    { name: '@holo-js/first', dependencies: { '@holo-js/second': 'catalog:' } },
    { name: '@holo-js/second', dependencies: { '@holo-js/first': 'catalog:' } },
  ])
  assert.throws(() => collectLibraryBuilds(root), /Circular library build dependency/)
})
