import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { validatePackageUpgrade } from './validate-package-upgrade.mjs'

const cleanups = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const optionalSessionPeer = range => ({ peerDependencies: { '@holo-js/session': range }, peerDependenciesMeta: { '@holo-js/session': { optional: true } } })

const publishedRelease = {
  '@holo-js/cli': { dependencies: { '@holo-js/core': '^0.1.0' }, ...optionalSessionPeer('^0.1.0') },
  '@holo-js/core': optionalSessionPeer('^0.1.0'),
  '@holo-js/session': {},
}

async function startPublishedRegistry() {
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://registry.local').pathname.slice(1))
    const manifest = publishedRelease[name]
    if (!manifest) {
      response.writeHead(404).end()
      return
    }
    const version = { name, version: '0.1.0', ...manifest, dist: { tarball: `http://registry.local/${name}/-/0.1.0.tgz`, integrity: 'sha512-AAAA' } }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name, 'dist-tags': { latest: '0.1.0' }, versions: { '0.1.0': version } }))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  cleanups.push(() => new Promise(resolveClose => server.close(resolveClose)))

  return `http://127.0.0.1:${server.address().port}`
}

async function createRepo(optionalPeerRange) {
  const root = await mkdtemp(join(tmpdir(), 'holo-package-upgrade-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const manifests = {
    cli: { name: '@holo-js/cli', dependencies: { '@holo-js/core': 'catalog:' }, ...optionalSessionPeer(optionalPeerRange) },
    core: { name: '@holo-js/core', ...optionalSessionPeer(optionalPeerRange) },
    session: { name: '@holo-js/session' },
    internal: { name: '@holo-js/internal', private: true },
  }
  const catalog = Object.fromEntries(Object.values(manifests).map(({ name }) => [name, '^0.1.0']))
  await writeFile(join(root, 'package.json'), JSON.stringify({ workspaces: { catalog } }))
  for (const [directory, manifest] of Object.entries(manifests)) {
    await mkdir(join(root, 'packages', directory), { recursive: true })
    await writeFile(join(root, 'packages', directory, 'package.json'), JSON.stringify({ version: '0.1.0', ...manifest }))
  }

  return root
}

test('fails when npm cannot upgrade the previous lockfile because optional Holo peers track the release', async () => {
  const upstream = await startPublishedRegistry()
  const root = await createRepo('catalog:')

  const failures = await validatePackageUpgrade({ root, upstream, managers: ['npm'] })

  assert.equal(failures.length, 1)
  assert.match(failures[0], /from 0\.1\.0 to 0\.2\.0/)
  assert.match(failures[0], /Conflicting peer dependency: @holo-js\/session@0\.2\.0/)
})

test('passes when optional Holo peers accept any version, for patch and minor releases', async () => {
  const upstream = await startPublishedRegistry()
  const root = await createRepo('*')
  const resolved = []

  const failures = await validatePackageUpgrade({ root, upstream, managers: ['npm'], log: message => resolved.push(message) })

  assert.deepEqual(failures, [])
  assert.deepEqual(resolved, [
    'npm: upgrading every @holo-js package from 0.1.0 to 0.1.1 resolves',
    'npm: upgrading every @holo-js package from 0.1.0 to 0.2.0 resolves',
  ])
})

test('passes when Bun upgrades a lockfile across patch and minor releases', async () => {
  const upstream = await startPublishedRegistry()
  const root = await createRepo('*')
  const resolved = []

  const failures = await validatePackageUpgrade({ root, upstream, managers: ['bun'], log: message => resolved.push(message) })

  assert.deepEqual(failures, [])
  assert.deepEqual(resolved, [
    'bun: upgrading every @holo-js package from 0.1.0 to 0.1.1 resolves',
    'bun: upgrading every @holo-js package from 0.1.0 to 0.2.0 resolves',
  ])
})
