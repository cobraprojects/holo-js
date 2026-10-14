import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function createRepository(context, exitCode = 0, changeDuringValidation = false) {
  const root = await mkdtemp(join(tmpdir(), 'holo-pre-push-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.githooks'))
  await copyFile(new URL('../.githooks/pre-push', import.meta.url), join(root, '.githooks/pre-push'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }))
  await writeFile(join(root, 'check.mjs'), `
import { writeFileSync } from 'node:fs'
if (process.env.GIT_DIR) throw new Error('Leaked Git environment')
${changeDuringValidation ? "writeFileSync('changed.txt', 'changed')" : ''}
console.log('Validation ran')
process.exitCode = ${exitCode}
`)
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'Initial'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  return { root, head }
}

function push({ root, head }) {
  return spawnSync('sh', ['.githooks/pre-push'], {
    cwd: root,
    input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n`,
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: join(root, '.git') },
  })
}

test('allows a clean commit only after successful validation', async (context) => {
  const result = push(await createRepository(context))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Validation ran/)
})

test('blocks a push when validation fails', async (context) => {
  const result = push(await createRepository(context, 7))
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /Validation ran/)
})

test('an installed hook prevents a real Git push from updating the remote after failed validation', async (context) => {
  const { root } = await createRepository(context, 7)
  const remote = await mkdtemp(join(tmpdir(), 'holo-pre-push-remote-'))
  context.after(() => rm(remote, { recursive: true, force: true }))
  for (const args of [
    ['init', '--bare', '--quiet', remote],
    ['config', 'core.hooksPath', '.githooks'],
    ['remote', 'add', 'origin', remote],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const result = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], { cwd: root, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /Validation ran/)
  assert.notEqual(spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', 'refs/heads/main']).status, 0)
})

test('blocks uncommitted changes before running validation', async (context) => {
  const repository = await createRepository(context)
  await writeFile(join(repository.root, 'untracked.mjs'), 'export const changed = true')
  const result = push(repository)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /commit or stash/)
  assert.doesNotMatch(result.stdout, /Validation ran/)
})

test('blocks changes made during otherwise successful validation', async (context) => {
  const result = push(await createRepository(context, 0, true))
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /Validation ran/)
  assert.match(result.stderr, /checkout changed during validation/)
})

test('blocks pushing a commit other than the checked out commit', async (context) => {
  const repository = await createRepository(context)
  const commit = spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Next'], { cwd: repository.root, encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
  const result = push(repository)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /check out the commit being pushed/)
  assert.doesNotMatch(result.stdout, /Validation ran/)
})
