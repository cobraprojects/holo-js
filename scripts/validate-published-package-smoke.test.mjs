import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePublishedManifest } from './validate-published-package-smoke.mjs'

test('resolves catalog and workspace ranges in published manifests', () => {
  const manifest = {
    dependencies: {
      '@holo-js/kernel': 'workspace:*',
      typescript: 'catalog:',
    },
    peerDependencies: {
      '@holo-js/db': 'workspace:^',
    },
  }
  const resolved = resolvePublishedManifest(
    manifest,
    { typescript: '^5.9.0' },
    new Map([
      ['@holo-js/kernel', '0.2.6'],
      ['@holo-js/db', '0.2.6'],
    ]),
  )

  assert.deepEqual(resolved, {
    dependencies: {
      '@holo-js/kernel': '0.2.6',
      typescript: '^5.9.0',
    },
    peerDependencies: {
      '@holo-js/db': '^0.2.6',
    },
  })
})

test('rejects unresolved catalog and workspace dependencies', () => {
  assert.throws(
    () => resolvePublishedManifest({ dependencies: { missing: 'catalog:' } }, {}, new Map()),
    /Missing catalog range/,
  )
  assert.throws(
    () => resolvePublishedManifest({ dependencies: { '@holo-js/missing': 'workspace:*' } }, {}, new Map()),
    /Missing workspace package version/,
  )
})

test('runs staged framework packages through production servers', async () => {
  const source = await readFile(join(import.meta.dirname, 'validate-published-package-smoke.mjs'), 'utf8')

  assert.match(source, /assertProductionApp/)
  assert.match(source, /bun', \['run', 'start'\]/)
  assert.match(source, /UnhandledPromiseRejection/)
})
