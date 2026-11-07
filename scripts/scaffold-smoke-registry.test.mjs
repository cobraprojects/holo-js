import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { resolveRegistrySnapshot, scaffoldSmokeNpmEnvironment } from './scaffold-smoke-registry.mjs'

const lockCommittedAt = '2026-01-02T03:04:05Z'
const laterCommittedAt = '2026-03-04T05:06:07Z'

function git(cwd, args, committedAt) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'holo',
      GIT_AUTHOR_EMAIL: 'holo@example.com',
      GIT_COMMITTER_NAME: 'holo',
      GIT_COMMITTER_EMAIL: 'holo@example.com',
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  })
  assert.equal(result.status, 0, result.stderr)
}

async function withRepository(callback) {
  const root = await mkdtemp(join(tmpdir(), 'holo-scaffold-registry-'))
  try {
    git(root, ['init', '--quiet'])
    await writeFile(join(root, 'bun.lock'), '{}\n')
    git(root, ['add', 'bun.lock'])
    git(root, ['commit', '--quiet', '-m', 'lock'], lockCommittedAt)
    await writeFile(join(root, 'README.md'), 'later\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '--quiet', '-m', 'later'], laterCommittedAt)
    await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('the registry snapshot is the last commit that changed bun.lock', async () => {
  await withRepository((root) => {
    assert.equal(resolveRegistrySnapshot(root), '2026-01-02T03:04:05.000Z')
  })
})

test('an uncommitted bun.lock change snapshots the registry at the current time', async () => {
  await withRepository(async (root) => {
    await writeFile(join(root, 'bun.lock'), '{ "changed": true }\n')
    assert.equal(resolveRegistrySnapshot(root, new Date('2026-05-06T07:08:09Z')), '2026-05-06T07:08:09.000Z')
  })
})

test('a shallow clone cannot resolve the registry snapshot', async () => {
  await withRepository(async (root) => {
    const clone = await mkdtemp(join(tmpdir(), 'holo-scaffold-registry-shallow-'))
    try {
      git(clone, ['clone', '--quiet', '--depth', '1', pathToFileURL(root).href, '.'])
      assert.throws(() => resolveRegistrySnapshot(clone), /shallow clone/)
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  })
})

test('the smoke npm environment pins resolution to the snapshot and ignores dist-tags', async () => {
  await withRepository((root) => {
    assert.deepEqual(scaffoldSmokeNpmEnvironment(root, {}), {
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_before: '2026-01-02T03:04:05.000Z',
      npm_config_tag: 'holo-scaffold-smoke-snapshot',
    })
  })
})

test('the offline mode pins resolution and never contacts the registry', async () => {
  await withRepository((root) => {
    assert.deepEqual(scaffoldSmokeNpmEnvironment(root, { HOLO_SCAFFOLD_SMOKE_OFFLINE: '1' }), {
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      npm_config_before: '2026-01-02T03:04:05.000Z',
      npm_config_tag: 'holo-scaffold-smoke-snapshot',
      npm_config_offline: 'true',
    })
  })
})

test('the live registry mode resolves packages without a snapshot', async () => {
  await withRepository((root) => {
    assert.deepEqual(scaffoldSmokeNpmEnvironment(root, { HOLO_SCAFFOLD_SMOKE_LIVE_REGISTRY: '1' }), {
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    })
  })
})
