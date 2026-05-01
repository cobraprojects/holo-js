import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readNotificationsDoc(name: string): Promise<string> {
  return readFile(resolve(root, 'apps/docs/docs/notifications', name), 'utf8')
}

describe('notifications documentation smoke checks', () => {
  it('covers the overview and package boundaries', async () => {
    const overview = await readNotificationsDoc('index.md')

    expect(overview).toContain('@holo-js/notifications')
    expect(overview).toContain('defineNotification(...)')
    expect(overview).toContain('notify(...)')
    expect(overview).toContain('notifyUsing()')
    expect(overview).toContain('email')
    expect(overview).toContain('database')
    expect(overview).toContain('broadcast')
    expect(overview).toContain('@holo-js/queue')
    expect(overview).toContain('@holo-js/core')
  })

  it('covers install flow, scaffolded files, and auth integration', async () => {
    const setup = await readNotificationsDoc('setup-and-cli.md')
    const installation = await readFile(resolve(root, 'apps/docs/docs/installation.md'), 'utf8')
    const verification = await readFile(resolve(root, 'apps/docs/docs/auth/email-verification.md'), 'utf8')
    const reset = await readFile(resolve(root, 'apps/docs/docs/auth/password-reset.md'), 'utf8')

    expect(setup).toContain('npx holo install notifications')
    expect(setup).toContain('config/notifications.ts')
    expect(setup).toContain('create_notifications')
    expect(setup).toContain('email verification')
    expect(setup).toContain('password reset')
    expect(installation).toContain('notifications')
    expect(installation).toContain('--package forms,validation,notifications')
    expect(verification).toContain('@holo-js/notifications')
    expect(verification).toContain('notify(created, verificationCreated(token))')
    expect(reset).toContain('notifyUsing()')
    expect(reset).toContain('auth.password-reset')
  })

  it('covers the final fluent API and custom channel story', async () => {
    const defining = await readNotificationsDoc('defining-notifications.md')
    const sending = await readNotificationsDoc('sending-notifications.md')
    const custom = await readNotificationsDoc('custom-channels.md')

    expect(defining).toContain('type: \'invoice-paid\'')
    expect(defining).toContain('queue:')
    expect(defining).toContain('delay:')
    expect(sending).toContain('notifyMany')
    expect(sending).toContain('.onQueue(\'notifications\')')
    expect(sending).toContain('.delayFor(\'email\', 300)')
    expect(sending).toContain('.afterCommit()')
    expect(sending).toContain('.channel(\'email\'')
    expect(custom).toContain('registerNotificationChannel')
    expect(custom).toContain('declare module \'@holo-js/notifications\'')
    expect(custom).toContain('HoloNotificationChannelRegistry')
  })
})
