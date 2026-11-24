import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { resolveReleaseManifest } from './release-manifests.mjs'
import {
  assertProductionApp,
  copyExternalDependencyClosure,
  createFrameworkNodeModules,
  createLinkedFrameworkNodeModules,
} from './validate-published-package-smoke.mjs'

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

async function writeStorePackage(storeRoot, name, storeVersion, dependencies = {}) {
  const [version] = storeVersion.split('+')
  const modulesRoot = join(storeRoot, `${name}@${storeVersion}/node_modules`)
  const packageRoot = join(modulesRoot, name)
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name, version, dependencies }))
  await writeFile(join(packageRoot, 'index.js'), `module.exports = ${JSON.stringify(version)}\n`)
  for (const [dependencyName, dependencyStoreVersion] of Object.entries(dependencies)) {
    await mkdir(dirname(join(modulesRoot, dependencyName)), { recursive: true })
    await symlink(join(storeRoot, `${dependencyName}@${dependencyStoreVersion}/node_modules/${dependencyName}`), join(modulesRoot, dependencyName))
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

async function withClosureFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'holo-smoke-closure-'))
  try {
    const storeRoot = join(root, 'store')
    const sourceAppRoot = join(root, 'source-app')
    const nodeModulesRoot = join(root, 'app/node_modules')
    await mkdir(join(sourceAppRoot, 'node_modules/.bin'), { recursive: true })
    await mkdir(nodeModulesRoot, { recursive: true })
    const installApp = async (dependencies) => {
      await writeFile(join(sourceAppRoot, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, packageRoot]) => [name, packageRoot ? 'installed' : 'staged'])) }))
      for (const [name, packageRoot] of Object.entries(dependencies)) {
        if (packageRoot) {
          await mkdir(dirname(join(sourceAppRoot, 'node_modules', name)), { recursive: true })
          await symlink(packageRoot, join(sourceAppRoot, 'node_modules', name))
        }
      }
    }
    const requireChain = (...packageNames) => {
      let require = createRequire(join(root, 'app/index.js'))
      const versions = []
      for (const packageName of packageNames) {
        const resolved = require.resolve(packageName)
        versions.push(require(resolved))
        require = createRequire(resolved)
      }
      return versions
    }
    return await callback({ root, storeRoot, sourceAppRoot, nodeModulesRoot, installApp, requireChain })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('copied installed dependency cycles whose versions shadow each other stay finite and resolve their installed versions', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, nodeModulesRoot, installApp, requireChain }) => {
    await writeStorePackage(storeRoot, 'a', '2.0.0', { b: '1.0.0' })
    await writeStorePackage(storeRoot, 'b', '1.0.0', { a: '1.0.0' })
    await writeStorePackage(storeRoot, 'a', '1.0.0', { b: '2.0.0' })
    await writeStorePackage(storeRoot, 'b', '2.0.0', { a: '2.0.0' })
    await installApp({ entry: await writeStorePackage(storeRoot, 'entry', '1.0.0', { a: '2.0.0' }) })

    await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, join(root, 'staged'))

    assert.deepEqual(
      requireChain('entry', 'a', 'b', 'a', 'b', 'a', 'b', 'a'),
      ['1.0.0', '2.0.0', '1.0.0', '1.0.0', '2.0.0', '2.0.0', '1.0.0', '1.0.0'],
    )
  })
})

test('a copied dependency resolves its installed version when a nested ancestor shadows the hoisted one', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, nodeModulesRoot, installApp, requireChain }) => {
    await writeStorePackage(storeRoot, 'a', '2.0.0', { b: '2.0.0' })
    await writeStorePackage(storeRoot, 'b', '2.0.0', { a: '1.0.0' })
    await installApp({
      a: await writeStorePackage(storeRoot, 'a', '1.0.0'),
      b: await writeStorePackage(storeRoot, 'b', '1.0.0'),
      entry: await writeStorePackage(storeRoot, 'entry', '1.0.0', { a: '2.0.0' }),
    })

    await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, join(root, 'staged'))

    assert.deepEqual(requireChain('entry', 'a', 'b', 'a'), ['1.0.0', '2.0.0', '2.0.0', '1.0.0'])
    assert.deepEqual(requireChain('a'), ['1.0.0'])
  })
})

test('staged framework packages keep the nested dependency versions they declare', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, installApp }) => {
    const rootUlid = await realpath(join(resolve(import.meta.dirname, '..'), 'node_modules/ulid'))
    const rootUlidVersion = JSON.parse(await readFile(join(rootUlid, 'package.json'), 'utf8')).version
    await writeStorePackage(storeRoot, 'ulid', '0.0.0-hoisted')
    await installApp({
      parser: await writeStorePackage(storeRoot, 'parser', '1.0.0', { ulid: '0.0.0-hoisted' }),
      '@holo-js/thing': undefined,
    })
    const stagedNodeModules = join(root, 'registry/node_modules')
    await mkdir(join(stagedNodeModules, '@holo-js/thing/dist'), { recursive: true })
    await writeFile(join(stagedNodeModules, '@holo-js/thing/package.json'), JSON.stringify({ name: '@holo-js/thing', version: '1.0.0', dependencies: { ulid: rootUlidVersion } }))
    await writeFile(join(stagedNodeModules, '@holo-js/thing/dist/index.js'), '')

    await createFrameworkNodeModules(sourceAppRoot, join(root, 'app'), stagedNodeModules)

    const requireFromThing = createRequire(join(root, 'app/node_modules/@holo-js/thing/dist/index.js'))
    const ulidFromThing = dirname(requireFromThing.resolve('ulid/package.json'))
    assert.equal(JSON.parse(await readFile(join(ulidFromThing, 'package.json'), 'utf8')).version, rootUlidVersion)
  })
})

test('two installations of the same package version keep the dependencies each was installed with', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, nodeModulesRoot, installApp, requireChain }) => {
    await writeStorePackage(storeRoot, 'dep', '1.0.0')
    await writeStorePackage(storeRoot, 'dep', '2.0.0')
    await writeStorePackage(storeRoot, 'plugin', '1.0.0+second', { dep: '2.0.0' })
    await installApp({
      plugin: await writeStorePackage(storeRoot, 'plugin', '1.0.0+first', { dep: '1.0.0' }),
      consumer: await writeStorePackage(storeRoot, 'consumer', '1.0.0', { plugin: '1.0.0+second' }),
    })

    await copyExternalDependencyClosure(sourceAppRoot, nodeModulesRoot, join(root, 'staged'))

    assert.deepEqual(requireChain('plugin', 'dep'), ['1.0.0', '1.0.0'])
    assert.deepEqual(requireChain('consumer', 'plugin', 'dep'), ['1.0.0', '1.0.0', '2.0.0'])
  })
})

test('staged framework packages resolve dependencies from their own installation before the app', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, installApp, requireChain }) => {
    await writeStorePackage(storeRoot, 'dep', '2.0.0')
    await installApp({
      dep: await writeStorePackage(storeRoot, 'dep', '1.0.0'),
      '@holo-js/thing': await writeStorePackage(storeRoot, '@holo-js/thing', '1.0.0', { dep: '2.0.0' }),
    })
    const stagedNodeModules = join(root, 'registry/node_modules')
    await mkdir(join(stagedNodeModules, '@holo-js/thing'), { recursive: true })
    await writeFile(join(stagedNodeModules, '@holo-js/thing/package.json'), JSON.stringify({ name: '@holo-js/thing', version: '1.0.0', dependencies: { dep: '2.0.0' } }))
    await writeFile(join(stagedNodeModules, '@holo-js/thing/index.js'), 'module.exports = \'staged\'\n')

    await createFrameworkNodeModules(sourceAppRoot, join(root, 'app'), stagedNodeModules)

    assert.deepEqual(requireChain('dep'), ['1.0.0'])
    assert.deepEqual(requireChain('@holo-js/thing', 'dep'), ['staged', '2.0.0'])
  })
})

test('linked framework packages get their own copy of an app dependency version they need', async () => {
  await withClosureFixture(async ({ root, storeRoot, sourceAppRoot, installApp, requireChain }) => {
    await writeStorePackage(storeRoot, 'dep', '2.0.0')
    const appDep = await writeStorePackage(storeRoot, 'dep', '1.0.0')
    await installApp({
      dep: appDep,
      '@holo-js/thing': await writeStorePackage(storeRoot, '@holo-js/thing', '1.0.0', { dep: '2.0.0' }),
    })
    const stagedNodeModules = join(root, 'registry/node_modules')
    await mkdir(join(stagedNodeModules, '@holo-js/thing'), { recursive: true })
    await writeFile(join(stagedNodeModules, '@holo-js/thing/package.json'), JSON.stringify({ name: '@holo-js/thing', version: '1.0.0', dependencies: { dep: '2.0.0' } }))
    await writeFile(join(stagedNodeModules, '@holo-js/thing/index.js'), 'module.exports = \'staged\'\n')

    await createLinkedFrameworkNodeModules(sourceAppRoot, join(root, 'app'), stagedNodeModules)

    assert.deepEqual(requireChain('dep'), ['1.0.0'])
    assert.equal(await realpath(join(root, 'app/node_modules/dep')), await realpath(appDep))
    assert.deepEqual(requireChain('@holo-js/thing', 'dep'), ['staged', '2.0.0'])
  })
})
