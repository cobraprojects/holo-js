import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'

it('rejects queued delivery when the installed mail package has no queue peer', async () => {
  const project = await mkdtemp(join(tmpdir(), 'holo-native-mail-peer-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  const source = resolve(import.meta.dirname, '..')
  await stagePublishedPackage(source, join(project, 'node_modules/@holo-js/mail'), join(source, 'dist'))
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(project, 'verify.mjs'), `
import assert from 'node:assert/strict'
import { defineMail, sendMail } from '@holo-js/mail'
await assert.rejects(async () => await sendMail(defineMail({ from: 'sender@example.com', to: 'ava@example.com', subject: 'Queued delivery', text: 'Queued' })).onQueue('mail'), /Queued or delayed mail delivery requires @holo-js\\/queue to be installed/)
`)
  const result = spawnSync(process.execPath, ['verify.mjs'], { cwd: project, encoding: 'utf8', timeout: 10000 })
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
})
