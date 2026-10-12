import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'

it('reports missing queue support from the installed SDK instead of a simulated import error', async () => {
  const project = await mkdtemp(join(tmpdir(), 'holo-notifications-installation-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  const source = resolve(import.meta.dirname, '..')
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
  await stagePublishedPackage(source, join(project, 'node_modules/@holo-js/notifications'), join(source, 'dist'))
  await writeFile(join(project, 'test.mjs'), `
import assert from 'node:assert/strict'
import { defineNotification, notify } from '@holo-js/notifications'
await assert.rejects(import('@holo-js/queue'), { code: 'ERR_MODULE_NOT_FOUND' })
const result = await notify({ id: 'recipient', type: 'users' }, defineNotification({
  type: 'queued.database',
  queue: true,
  via: () => ['database'],
  build: { database: () => ({ data: { delivered: true } }) },
}))
assert.equal(result.channels.length, 1)
assert.equal(result.channels[0].success, false)
assert.match(result.channels[0].error.message, /require @holo-js\\/queue to be installed/)
`)
  const result = spawnSync(process.execPath, [join(project, 'test.mjs')], { cwd: project, encoding: 'utf8', timeout: 30_000 })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
