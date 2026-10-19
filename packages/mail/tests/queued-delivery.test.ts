import { afterEach, describe, expect, it } from 'vitest'
import { runQueueWorker } from '@holo-js/queue'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import {
  configureMailRuntime,
  defineMail,
  listFakeSentMails,
  normalizeMailConfig,
  registerMailDriver,
  resetFakeSentMails,
  resetMailDriverRegistry,
  resetMailRuntime,
  sendMail,
} from '../src'

afterEach(() => {
  resetFakeSentMails()
  resetMailDriverRegistry()
  resetMailRuntime()
})

describe('@holo-js/mail queued delivery options', () => {
  it('persists queued mail tries as max attempts and defaults to one attempt', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      configureMailRuntime({
        config: normalizeMailConfig({
          default: 'fake',
          from: { email: 'sender@example.com' },
          mailers: { fake: { driver: 'fake' } },
        }),
      })
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Limited mail',
        text: 'Limited',
        queue: { queued: true, connection: 'database', queue: 'mail', tries: 3 },
      }))
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Default mail',
        text: 'Default',
        queue: { queued: true, connection: 'database', queue: 'mail' },
      }))
      const rows = await database.readJobRows()
      expect(rows).toHaveLength(2)
      expect(rows.map(row => [JSON.parse(String(row.payload)).mail.subject, row.max_attempts])).toEqual(expect.arrayContaining([
        ['Limited mail', 3],
        ['Default mail', 1],
      ]))
    } finally {
      await database.cleanup()
    }
  })

  it('retries a failing queued mail after its backoff and delivers the next attempt', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      const attempts: string[] = []
      registerMailDriver('flaky', {
        send(mail) {
          attempts.push(mail.subject)
          if (attempts.length === 1) throw new Error('transient')
          return { messageId: 'flaky-message', mailer: 'flaky', driver: 'flaky', queued: false }
        },
      })
      configureMailRuntime({
        config: normalizeMailConfig({
          default: 'flaky',
          from: { email: 'sender@example.com' },
          mailers: { flaky: { driver: 'flaky' } },
        }),
      })
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Retried mail',
        text: 'Retry',
        queue: { queued: true, connection: 'database', queue: 'mail', tries: 2, backoff: 1 },
      }))
      const released: (number | undefined)[] = []
      expect(await runQueueWorker({
        connection: 'database',
        queueNames: ['mail'],
        once: true,
        onJobReleased: ({ delaySeconds }) => { released.push(delaySeconds) },
      })).toMatchObject({ processed: 0, released: 1, failed: 0 })
      expect(released).toEqual([1])
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true }))
        .toMatchObject({ processed: 1, failed: 0 })
      expect(attempts).toEqual(['Retried mail', 'Retried mail'])
      expect(await database.readJobRows()).toEqual([])
    } finally {
      await database.cleanup()
    }
  })

  it('fails a queued mail terminally when its backoff is set but no attempts remain', async () => {
    const database = await createSQLiteQueueHarness({ createFailedTable: true })
    try {
      let handled = 0
      registerMailDriver('broken', {
        send() {
          handled += 1
          throw new Error('still failing')
        },
      })
      configureMailRuntime({
        config: normalizeMailConfig({
          default: 'broken',
          from: { email: 'sender@example.com' },
          mailers: { broken: { driver: 'broken' } },
        }),
      })
      await sendMail(defineMail({
        to: 'ava@example.com',
        subject: 'Exhausted mail',
        text: 'Exhausted',
        queue: { queued: true, connection: 'database', queue: 'mail', tries: 2, backoff: 0 },
      }))
      expect(await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true }))
        .toMatchObject({ released: 1, failed: 0 })
      expect(await runQueueWorker({ connection: 'database', queueNames: ['mail'], once: true }))
        .toMatchObject({ processed: 0, failed: 1 })
      expect(handled).toBe(2)
      expect(await database.readFailedRows()).toHaveLength(1)
      expect(listFakeSentMails()).toEqual([])
    } finally {
      await database.cleanup()
    }
  })
})
