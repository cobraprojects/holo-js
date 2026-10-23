import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { listUnpublishedPackages } from './list-unpublished-packages.mjs'

const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createTempRepo(packages) {
  const root = await mkdtemp(join(tmpdir(), 'holo-unpublished-'))
  tempRoots.push(root)
  for (const [directory, manifest] of Object.entries(packages)) {
    const manifestPath = join(root, 'packages', directory, 'package.json')
    await mkdir(dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  }
  return root
}

function registryWith(publishedVersions) {
  const requested = []
  const fetchImpl = async url => {
    requested.push(url.toString())
    const published = publishedVersions.has(url.toString().replace('https://registry.npmjs.org/', ''))
    return { ok: published, status: published ? 200 : 404 }
  }
  return { fetchImpl, requested }
}

test('lists the publishable package versions that npm does not have yet', async () => {
  const root = await createTempRepo({
    core: { name: '@holo-js/core', version: '0.3.28' },
    queue: { name: '@holo-js/queue', version: '0.3.29' },
  })
  const { fetchImpl, requested } = registryWith(new Set(['@holo-js%2Fcore/0.3.28']))

  assert.deepEqual(await listUnpublishedPackages({ root, fetchImpl }), ['@holo-js/queue@0.3.29'])
  assert.deepEqual(requested, [
    'https://registry.npmjs.org/@holo-js%2Fcore/0.3.28',
    'https://registry.npmjs.org/@holo-js%2Fqueue/0.3.29',
  ])
})

test('treats every publishable package as due when nothing is on npm yet', async () => {
  const root = await createTempRepo({
    core: { name: '@holo-js/core', version: '0.3.28' },
  })
  const { fetchImpl } = registryWith(new Set())

  assert.deepEqual(await listUnpublishedPackages({ root, fetchImpl }), ['@holo-js/core@0.3.28'])
})

test('reports nothing due when every publishable version is already on npm', async () => {
  const root = await createTempRepo({
    core: { name: '@holo-js/core', version: '0.3.28' },
  })
  const { fetchImpl } = registryWith(new Set(['@holo-js%2Fcore/0.3.28']))

  assert.deepEqual(await listUnpublishedPackages({ root, fetchImpl }), [])
})

test('skips private packages and directories without a manifest', async () => {
  const root = await createTempRepo({
    internal: { name: 'internal', version: '0.0.0', private: true },
    core: { name: '@holo-js/core', version: '0.3.28' },
  })
  await mkdir(join(root, 'packages', 'no-manifest'), { recursive: true })
  const { fetchImpl, requested } = registryWith(new Set(['@holo-js%2Fcore/0.3.28']))

  assert.deepEqual(await listUnpublishedPackages({ root, fetchImpl }), [])
  assert.deepEqual(requested, ['https://registry.npmjs.org/@holo-js%2Fcore/0.3.28'])
})

test('fails instead of treating a registry outage as an unpublished package', async () => {
  const root = await createTempRepo({
    core: { name: '@holo-js/core', version: '0.3.28' },
  })
  const fetchImpl = async () => ({ ok: false, status: 503 })

  await assert.rejects(
    listUnpublishedPackages({ root, fetchImpl }),
    /npm registry responded 503 for @holo-js\/core@0\.3\.28/,
  )
})

const canRevokeTraversal = process.platform !== 'win32' && process.getuid?.() !== 0

test('fails when a package manifest cannot be checked instead of dropping the package from the release gate', { skip: !canRevokeTraversal }, async () => {
  const root = await createTempRepo({
    core: { name: '@holo-js/core', version: '0.3.28' },
  })
  const lockedDirectory = join(root, 'packages', 'locked')
  await mkdir(lockedDirectory)
  await writeFile(join(lockedDirectory, 'package.json'), JSON.stringify({ name: '@holo-js/locked', version: '0.3.29' }))
  await chmod(lockedDirectory, 0o000)

  try {
    const { fetchImpl } = registryWith(new Set())
    await assert.rejects(listUnpublishedPackages({ root, fetchImpl }), { code: 'EACCES' })
  } finally {
    await chmod(lockedDirectory, 0o755)
  }
})
