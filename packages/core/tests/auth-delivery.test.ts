import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureNotificationsRuntime, defineNotification, notify, resetNotificationsRuntime, type NotificationMailMessage } from '@holo-js/notifications'
import { holoRuntimeInternals } from '../src/portable/holo'
import { createCoreAuthDeliveryHook } from '../src/portable/authDelivery'

type SentMail = Parameters<Parameters<typeof holoRuntimeInternals.createAuthMailDeliveryHook>[0]['sendMail']>[0]
type DeliveredMessage = NotificationMailMessage | SentMail
const app = { name: 'Holo App', url: 'https://example.com' }
const roots: string[] = []
const token = { id: 'token-id', plainTextToken: 'a&b +/#', createdAt: new Date('2026-10-08T12:30:00Z'), expiresAt: new Date('2026-10-08T13:15:00Z') }
const verification = { provider: 'users', user: { name: '  Ava <&"\'>  ' }, email: 'ava@example.com', token, route: 'verify?source=email&token=old#finish' }

afterEach(async () => {
  resetNotificationsRuntime()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Auth delivery', () => {
  it('delivers the same verification content through Notifications and the notification Mail template', async () => {
    const notified: NotificationMailMessage[] = []
    const mailed: SentMail[] = []
    configureNotificationsRuntime({ mailer: { async send(message) { notified.push(message) } } })
    await holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com/base/').sendEmailVerification(verification)
    await holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { mailed.push(mail) } }, { ...app, url: 'https://example.com/base/' }).sendEmailVerification(verification)

    const url = 'https://example.com/base/verify?source=email&token=a%26b+%2B%2F%23#finish'
    const content = {
      lines: ['Please click the button below to verify your email address.'],
      action: { label: 'Verify Email Address', url },
      outroLines: ['If you did not create an account, no further action is required.'],
    }
    expect(notified).toEqual([{ subject: 'Verify Email Address', ...content, metadata: { provider: 'users', tokenId: 'token-id' } }])
    expect(mailed).toEqual([{
      to: { email: 'ava@example.com', name: 'Ava <&"\'>' },
      subject: 'Verify Email Address',
      markdown: 'notifications/email',
      data: { ...content, greeting: 'Hello!', level: 'info', actionColor: 'primary', salutation: 'Regards,\\\nHolo App' },
      metadata: { provider: 'users', tokenId: 'token-id' },
    }])
  })

  it('lets a project notification replace the complete default delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-auth-delivery-'))
    roots.push(root)
    await mkdir(join(root, 'server/notifications/auth'), { recursive: true })
    const messages: DeliveredMessage[] = []
    configureNotificationsRuntime({ mailer: { async send(message) { messages.push(message) } } })
    const delivery = holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com', root)
    await delivery.sendEmailVerification(verification)
    await writeFile(join(root, 'server/notifications/auth/email-verification.mjs'), `
export const emailVerificationNotification = {
  type: 'project.verification',
  via() { return ['email'] },
  build: { email(input) { return { subject: 'Project verification', text: input.url, metadata: { custom: true, name: input.name, expiresInMinutes: input.expiresInMinutes } } } },
}
export default { via() { return ['email'] }, build: { email() { return { subject: 'Wrong export' } } } }
`)
    await delivery.sendEmailVerification(verification)
    expect(messages[0]?.subject).toBe('Verify Email Address')
    expect(messages[1]).toEqual({ subject: 'Project verification', text: 'https://example.com/verify?source=email&token=a%26b+%2B%2F%23#finish', metadata: { custom: true, name: 'Ava <&"\'>', expiresInMinutes: 45 } })
  })

  it.each([{ name: '   ' }, { name: 42 }, null])('omits unusable verification names for %j', async (user) => {
    const sent: SentMail[] = []
    const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { sent.push(mail) } }, app)
    await delivery.sendEmailVerification({ ...verification, user })
    expect(sent[0]?.to).toEqual({ email: 'ava@example.com' })
  })

  it('delivers password reset content without a recipient name or broker metadata', async () => {
    const notified: NotificationMailMessage[] = []
    const mailed: SentMail[] = []
    const input = { broker: 'admins', provider: 'users', email: 'ava@example.com', token, route: '/reset-password' }
    configureNotificationsRuntime({ mailer: { async send(message, context) {
      expect(context.route).toEqual({ email: 'ava@example.com' })
      notified.push(message)
    } } })
    await holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com').sendPasswordReset(input)
    await holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { mailed.push(mail) } }, app).sendPasswordReset(input)

    const content = {
      lines: ['You are receiving this email because we received a password reset request for your account.'],
      action: { label: 'Reset Password', url: 'https://example.com/reset-password?token=a%26b+%2B%2F%23' },
      outroLines: ['This password reset link will expire in 45 minutes.', 'If you did not request a password reset, no further action is required.'],
    }
    expect(notified).toEqual([{ subject: 'Reset Password Notification', ...content, metadata: { provider: 'users', tokenId: 'token-id' } }])
    expect(mailed).toEqual([{
      to: { email: 'ava@example.com' },
      subject: 'Reset Password Notification',
      markdown: 'notifications/email',
      data: { ...content, greeting: 'Hello!', level: 'info', actionColor: 'primary', salutation: 'Regards,\\\nHolo App' },
      metadata: { provider: 'users', tokenId: 'token-id' },
    }])
  })

  it('propagates a selected invalid custom definition instead of using another export or file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-auth-delivery-'))
    roots.push(root)
    await mkdir(join(root, 'server/notifications/auth'), { recursive: true })
    await writeFile(join(root, 'server/notifications/auth/password-reset.mjs'), `
export const passwordResetNotification = { invalid: true }
export default { via() { return ['email'] }, build: { email() { return { subject: 'Wrong export' } } } }
`)
    await writeFile(join(root, 'server/notifications/auth/password-reset.cjs'), `module.exports = { via() { return ['email'] }, build: { email() { return { subject: 'Wrong file' } } } }`)
    const delivery = holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com', root)
    await expect(delivery.sendPasswordReset({ ...verification, broker: 'users' })).rejects.toThrow('Auth notification file "server/notifications/auth/password-reset.mjs" must export a notification definition with an email message.')
  })

  it('preserves Notifications transport failure handling without retrying through Mail', async () => {
    const failure = new Error('Transport unavailable')
    let notificationsAttempts = 0
    let mailAttempts = 0
    configureNotificationsRuntime({ mailer: { async send() { notificationsAttempts++; throw failure } } })
    const delivery = createCoreAuthDeliveryHook({
      app,
      notifications: { defineNotification, notify },
      mail: { async sendMail() { mailAttempts++ } },
    })
    if (!delivery) {
      throw new Error('Expected configured Auth delivery')
    }
    await expect(delivery.sendEmailVerification(verification)).resolves.toBeUndefined()
    expect(notificationsAttempts).toBe(1)
    expect(mailAttempts).toBe(0)
  })

  it('propagates the original direct Mail failure', async () => {
    const failure = new Error('Transport unavailable')
    const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail() { throw failure } }, app)
    await expect(delivery.sendEmailVerification(verification)).rejects.toBe(failure)
  })
})
