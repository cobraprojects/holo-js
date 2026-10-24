import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createExampleAppFixture } from '../tests/support/example-app-fixture.mjs'
import { closeWriteStream, exampleAppRunVariable, listTaggedProcesses, stopExampleAppProcess, stopTaggedProcesses } from '../tests/example-app-process.mjs'

test('app source edits and generated files stay inside each journey fixture', async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-app-fixture-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'apps/blog-next')
  for (const directory of ['packages', 'tests', 'node_modules', 'apps/blog-next/node_modules', 'apps/blog-next/.next', 'apps/blog-next/app/storage']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  await writeFile(join(source, 'job.ts'), 'original job')
  await writeFile(join(source, '.next/stale'), 'stale output')
  await writeFile(join(source, 'app/storage/route.ts'), 'storage route')
  const first = await createExampleAppFixture(root, 'next')
  context.after(() => rm(first.directory, { recursive: true, force: true }))
  await writeFile(join(first.projectRoot, 'job.ts'), 'changed job')
  await assert.rejects(readFile(join(first.projectRoot, '.next/stale')), { code: 'ENOENT' })
  assert.equal(await readFile(join(first.projectRoot, 'app/storage/route.ts'), 'utf8'), 'storage route')
  const second = await createExampleAppFixture(root, 'next')
  context.after(() => rm(second.directory, { recursive: true, force: true }))
  assert.equal(await readFile(join(source, 'job.ts'), 'utf8'), 'original job')
  assert.equal(await readFile(join(second.projectRoot, 'job.ts'), 'utf8'), 'original job')
})

test('stops remaining descendants after the process group leader exits', { skip: process.platform === 'win32' }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-process-fixture-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const stoppedPath = join(root, 'stopped')
  const worker = "const {writeFileSync} = require('node:fs'); setInterval(() => {}, 1000); process.once('SIGTERM', () => setTimeout(() => {writeFileSync(process.argv[1], 'stopped'); process.exit(0)}, 100)); process.send('ready')"
  const leader = `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}, ${JSON.stringify(stoppedPath)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.once('message', () => process.exit(0))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', leader], {
    detached: true,
    stdio: 'ignore',
  })
  context.after(() => stopExampleAppProcess(child, 'SIGKILL'))
  await once(child, 'close')
  await stopExampleAppProcess(child)
  assert.equal(await readFile(stoppedPath, 'utf8'), 'stopped')
})

test('stops a detached descendant that outlives the journey before its directory is removed', { skip: process.platform === 'win32' }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-process-tag-'))
  const runId = `test-${process.pid}-${Date.now()}`
  context.after(async () => {
    await stopTaggedProcesses(runId)
    await rm(root, { recursive: true, force: true })
  })
  const storage = join(root, 'storage')
  await mkdir(storage)
  const writer = "const {writeFileSync} = require('node:fs'); let n = 0; setInterval(() => writeFileSync(`${process.argv[1]}/${n++}.log`, 'x'), 5); process.send('ready')"
  const leader = `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}, ${JSON.stringify(storage)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.once('message', () => { child.disconnect(); child.unref(); process.exit(0) })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', leader], {
    detached: true,
    env: { ...process.env, [exampleAppRunVariable]: runId },
    stdio: 'ignore',
  })
  await once(child, 'close')
  assert.equal((await listTaggedProcesses(runId)).length, 1)
  const stopped = await stopTaggedProcesses(runId)
  assert.equal(stopped.length, 1)
  assert.match(stopped[0].command, /writeFileSync/)
  assert.deepEqual(await listTaggedProcesses(runId), [])
  await rm(storage, { recursive: true })
  await assert.rejects(readFile(join(storage, '0.log')), { code: 'ENOENT' })
})

test('closing a log stream settles when the stream was already destroyed', async context => {
  const root = await mkdtemp(join(tmpdir(), 'holo-log-close-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const destroyed = createWriteStream(join(root, 'destroyed.log'))
  destroyed.destroy()
  await once(destroyed, 'close')
  await closeWriteStream(destroyed)
  const failed = createWriteStream(join(root, 'missing', 'failed.log'))
  failed.on('error', () => {})
  await new Promise(resolve => failed.once('close', resolve))
  await assert.rejects(closeWriteStream(failed), { code: 'ENOENT' })
  const open = createWriteStream(join(root, 'open.log'))
  open.write('line\n')
  await closeWriteStream(open)
  assert.equal(await readFile(join(root, 'open.log'), 'utf8'), 'line\n')
})
