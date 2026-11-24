import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveReleaseManifest } from './release-manifests.mjs'
import { assertProductionApp, copyExternalDependencyClosure } from './validate-published-package-smoke.mjs'

test('resolves catalog and workspace ranges in published manifests', () => {
  const manifest = {
    dependencies: {
      '@holo-js/kernel': 'workspace:*',
      typescript: 'catalog:',
    },
    peerDependencies: {
      '@holo-js/db': 'catalog:',
    },
    optionalDependencies: { external: '^2.0.0' },
    devDependencies: { '@holo-js/kernel': 'workspace:*' },
  }
  const resolved = resolveReleaseManifest(
    manifest,
    { typescript: '^5.9.0', '@holo-js/kernel': '^0.2.6', '@holo-js/db': '^0.2.6' },
  )

  assert.deepEqual(resolved, {
    dependencies: {
      '@holo-js/kernel': '^0.2.6',
      typescript: '^5.9.0',
    },
    peerDependencies: {
      '@holo-js/db': '^0.2.6',
    },
    optionalDependencies: { external: '^2.0.0' },
    devDependencies: { '@holo-js/kernel': '^0.2.6' },
  })
})

test('rejects unresolved catalog and workspace dependencies', () => {
  assert.throws(
    () => resolveReleaseManifest({ dependencies: { missing: 'catalog:' } }, {}),
    /Cannot resolve catalog range/,
  )
  assert.throws(
    () => resolveReleaseManifest({ dependencies: { '@holo-js/missing': 'workspace:*' } }, {}),
    /Cannot resolve catalog range/,
  )
})

async function withFakeApp(serverSource, callback) {
  const appRoot = await mkdtemp(join(tmpdir(), 'holo-smoke-app-'))
  try {
    const bin = join(appRoot, 'node_modules/@holo-js/cli/dist/bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'holo.mjs'), serverSource)
    return await callback(appRoot)
  } finally {
    await rm(appRoot, { recursive: true, force: true })
  }
}

const app = { name: 'fake', expectedTitle: 'Expected Blog Title' }
const serveAfter = (delayMs, body, status = 200) => `
import { createServer } from 'node:http'
setTimeout(() => {
  createServer((request, response) => response.writeHead(${status}, { 'content-type': 'text/html' }).end(${JSON.stringify(body)}))
    .listen(Number(process.env.PORT), process.env.HOST)
}, ${delayMs})
`

test('a production app serving the wrong page fails its assertion instead of timing out', async () => {
  await withFakeApp(serveAfter(0, '<title>Some Other Page</title>'), async (appRoot) => {
    await assert.rejects(assertProductionApp(appRoot, app, {}), (error) => {
      assert.match(error.message, /Expected Blog Title/)
      assert.doesNotMatch(error.message, /Timed out/)
      return true
    })
  })
})

test('a production app returning an error status fails with that status', async () => {
  await withFakeApp(serveAfter(0, 'Internal failure', 500), async (appRoot) => {
    await assert.rejects(assertProductionApp(appRoot, app, {}), (error) => {
      assert.match(error.message, /500/)
      assert.match(error.message, /Internal failure/)
      assert.doesNotMatch(error.message, /Timed out/)
      return true
    })
  })
})

test('waits for a production app that starts listening late', async () => {
  await withFakeApp(serveAfter(1500, '<title>Expected Blog Title</title>'), async (appRoot) => {
    await assertProductionApp(appRoot, app, {})
  })
})

test('a production app that exits before listening fails with its exit code and output', async () => {
  await withFakeApp(`console.error('missing build output'); process.exit(3)\n`, async (appRoot) => {
    await assert.rejects(assertProductionApp(appRoot, app, {}), /exited with code 3[\s\S]*missing build output/)
  })
})

async function writeStorePackage(storeRoot, name, version, dependencies = {}) {
  const packageRoot = join(storeRoot, `${name}@${version}/node_modules/${name}`)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version, dependencies }))
  await writeFile(join(packageRoot, 'index.js'), `module.exports = ${JSON.stringify(version)}\n`)
  for (const [dependencyName, dependencyVersion] of Object.entries(dependencies)) {
    await symlink(join(storeRoot, `${dependencyName}@${dependencyVersion}/node_modules/${dependencyName}`), join(packageRoot, '..', dependencyName))
  }
  return packageRoot
}

test('copied app dependencies keep the transitive versions each package was installed with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-smoke-closure-'))
  try {
    const storeRoot = join(root, 'store')
    await writeStorePackage(storeRoot, 'entities', '7.0.1')
    const entities = await writeStorePackage(storeRoot, 'entities', '9.0.0')
    const parser = await writeStorePackage(storeRoot, 'parser', '1.0.0', { entities: '7.0.1' })
    const sourceAppRoot = join(root, 'source-app')
    await mkdir(join(sourceAppRoot, 'node_modules'), { recursive: true })
    await writeFile(join(sourceAppRoot, 'package.json'), JSON.stringify({ dependencies: { parser: '1.0.0', entities: '9.0.0' } }))
    await symlink(parser, join(sourceAppRoot, 'node_modules/parser'))
    await symlink(entities, join(sourceAppRoot, 'node_modules/entities'))
    const nodeModulesRoot = join(root, 'app/node_modules')
    await mkdir(nodeModulesRoot, { recursive: true })

    await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, join(root, 'staged'))

    const requireFromApp = createRequire(join(root, 'app/index.js'))
    const requireFromParser = createRequire(requireFromApp.resolve('parser'))
    assert.equal(requireFromApp('entities'), '9.0.0')
    assert.equal(requireFromParser('entities'), '7.0.1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
