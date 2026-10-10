import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveReleaseManifest } from './release-manifests.mjs'

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
