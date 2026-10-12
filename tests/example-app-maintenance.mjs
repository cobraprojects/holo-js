import { assertExampleAppNotificationBehavior } from './example-app-notifications.mjs'
import { assertExampleAppQueueListener } from './example-app-queue-listen.mjs'
import { assertExampleAppBroadcastTransactions } from './example-app-broadcast-transactions.mjs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export function runMaintenance(...args) {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../packages/cli/dist/bin/holo.mjs'), ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000,
  })
  assert.equal(result.status, 0, `${args.join(' ')} failed.\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

export async function assertExampleAppQueueMaintenance(DB, IndexBlogPost, post, broadcastRaw, createSchemaService) {
  await assertExampleAppNotificationBehavior(process.cwd(), DB, runMaintenance)
  await assertExampleAppBroadcastTransactions(DB, broadcastRaw, runMaintenance)
  assert.deepEqual(await IndexBlogPost.dispatchSync({ action: 'updated', postId: post.id }), {
    action: 'updated', postId: post.id, indexed: true, title: post.title,
  })
  const jobs = DB.table('jobs').where('queue', 'default')
  const queued = await jobs.count()
  assert.ok(queued > 0, 'App mutations must enqueue real jobs before testing maintenance.')
  const output = runMaintenance('queue:work', '--once', '--connection', 'database', '--queue', 'default')
  assert.match(output, /processed=1 released=0 failed=0/)
  assert.equal(await jobs.count(), queued - 1)
  assert.equal(await DB.table('failed_jobs').count(), 0)
  await IndexBlogPost.dispatch({ action: 'updated', postId: post.id }).onQueue('maintenance-other')
  assert.match(runMaintenance('queue:clear', '--connection', 'database', '--queue', 'default'), new RegExp(`Cleared ${queued - 1} pending job`))
  assert.equal(await jobs.count(), 0)
  assert.equal(await DB.table('jobs').where('queue', 'maintenance-other').count(), 1)
  assert.match(runMaintenance('queue:clear', '--connection', 'database'), /Cleared 0 pending job/)
  assert.equal(await DB.table('jobs').where('queue', 'maintenance-other').count(), 1)
  assert.match(runMaintenance('queue:clear', '--connection', 'database', '--queue', 'maintenance-other'), /Cleared 1 pending job/)
  assert.equal(await DB.table('jobs').count(), 0)
  await assertFailedJobMaintenance(DB, IndexBlogPost, post, createSchemaService)
  await assertExampleAppQueueListener(DB, IndexBlogPost, post, runMaintenance)
}

async function assertFailedJobMaintenance(DB, IndexBlogPost, post, createSchemaService) {
  const schema = createSchemaService(DB.connection())
  const failJobs = async count => {
    await schema.renameTable('posts', 'posts_during_maintenance')
    try {
      for (let index = 0; index < count; index++) {
        await IndexBlogPost.dispatch({ action: 'updated', postId: post.id })
      }
      const output = runMaintenance('queue:work', '--connection', 'database', '--queue', 'default', '--stop-when-empty', '--max-jobs', String(count), '--tries', '1')
      assert.match(output, new RegExp(`processed=0 released=0 failed=${count}`))
      assert.equal(await DB.table('jobs').count(), 0)
    } finally {
      await schema.renameTable('posts_during_maintenance', 'posts')
    }
  }

  await failJobs(2)
  const failed = await DB.table('failed_jobs').get()
  assert.equal(failed.length, 2)
  const listed = runMaintenance('queue:failed')
  for (const record of failed) {
    assert.match(record.exception, /posts/)
    assert.ok(listed.includes(record.id))
    assert.ok(listed.includes(record.job))
  }
  assert.match(runMaintenance('queue:retry', failed[0].id), /Retried 1 failed job/)
  assert.equal(await DB.table('failed_jobs').count(), 1)
  assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'default', '--once'), /processed=1 released=0 failed=0/)
  assert.match(runMaintenance('queue:retry', 'all'), /Retried 1 failed job/)
  assert.equal(await DB.table('failed_jobs').count(), 0)
  assert.match(runMaintenance('queue:work', '--connection', 'database', '--queue', 'default', '--once'), /processed=1 released=0 failed=0/)
  assert.equal(await DB.table('jobs').count(), 0)

  await failJobs(2)
  const forgotten = await DB.table('failed_jobs').first()
  assert.ok(forgotten)
  assert.match(runMaintenance('queue:forget', forgotten.id), /Forgot failed job/)
  assert.equal(await DB.table('failed_jobs').count(), 1)
  assert.match(runMaintenance('queue:flush'), /Flushed 1 failed job/)
  assert.equal(await DB.table('failed_jobs').count(), 0)
  assert.match(runMaintenance('queue:failed'), /No failed jobs/)
}
