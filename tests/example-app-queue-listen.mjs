import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { stopExampleAppProcess } from './example-app-process.mjs'

export async function assertExampleAppQueueListener(DB, IndexBlogPost, post, runMaintenance) {
  const jobPath = resolve('server/jobs/blog/index-post.ts')
  const modelPath = resolve('server/models/Post.ts')
  const originalJob = await readFile(jobPath, 'utf8')
  const originalModel = await readFile(modelPath, 'utf8')
  const changedJob = originalJob.replace('const post = await Post.find(payload.postId)', `console.log('queue:active-job')
    await new Promise(resolve => setTimeout(resolve, 3000))
    const post = await Post.findOrFail(-1)`)
  assert.notEqual(changedJob, originalJob)
  let output = ''
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../packages/cli/dist/bin/holo.mjs'), 'queue:listen', '--connection', 'database', '--queue', 'default', '--tries', '1'], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { output += chunk.toString() })
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, output)
      if (await predicate()) return
      await setTimeout(50)
    }
    assert.fail(`${message}\n${output}`)
  }
  const stoppedCount = () => output.match(/\[queue\] Stopped/g)?.length ?? 0
  const reload = async (path, content) => {
    const previous = stoppedCount()
    await writeFile(path, content)
    await waitFor(() => stoppedCount() > previous, `The worker did not reload after changing ${path}`)
  }
  const processJob = async (failed) => {
    await IndexBlogPost.dispatch({ action: 'updated', postId: post.id })
    await waitFor(async () => await DB.table('jobs').where('queue', 'default').count() === 0, 'The listener did not process the queued job')
    assert.equal(await DB.table('failed_jobs').count(), failed)
  }
  try {
    await processJob(0)
    await reload(jobPath, changedJob)
    await IndexBlogPost.dispatch({ action: 'updated', postId: post.id })
    await waitFor(() => output.includes('queue:active-job'), 'The modified handler did not start')
    await reload(jobPath, originalJob)
    assert.equal(await DB.table('jobs').where('queue', 'default').count(), 0)
    assert.equal(await DB.table('failed_jobs').count(), 1)
    const failure = await DB.table('failed_jobs').first()
    assert.ok(failure)
    assert.match(failure.exception, /record not found for key "-1"/)
    assert.match(runMaintenance('queue:flush'), /Flushed 1 failed job/)
    await processJob(0)
    await reload(modelPath, `${originalModel}\n`)
    await processJob(0)
    const previous = stoppedCount()
    assert.match(runMaintenance('queue:restart'), /Restart signal written/)
    await waitFor(() => stoppedCount() > previous, 'The listener did not restart after the CLI restart command')
    await processJob(0)
  } finally {
    try {
      await stopExampleAppProcess(child, 'SIGINT')
    } finally {
      await Promise.all([writeFile(jobPath, originalJob), writeFile(modelPath, originalModel)])
      runMaintenance('prepare')
    }
  }
}
