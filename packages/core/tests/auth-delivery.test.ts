import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureNotificationsRuntime, defineNotification, notify, resetNotificationsRuntime, type NotificationMailMessage } from '@holo-js/notifications'
import { holoRuntimeInternals } from '../src/portable/holo'
import { createCoreAuthDeliveryHook } from '../src/portable/authDelivery'

type DeliveredMessage = NotificationMailMessage | Parameters<Parameters<typeof holoRuntimeInternals.createAuthMailDeliveryHook>[0]['sendMail']>[0]
const roots: string[] = []
const token = { id: 'token-id', plainTextToken: 'a&b +/#', expiresAt: new Date('2026-10-08T12:30:00Z') }
const verification = { provider: 'users', user: { name: '  Ava <&"\'>  ' }, email: 'ava@example.com', token, route: 'verify?source=email&token=old#finish' }

afterEach(async () => {
  resetNotificationsRuntime()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Auth delivery', () => {
  it('delivers the same escaped verification content through Notifications and Mail', async () => {
    const messages: DeliveredMessage[] = []
    configureNotificationsRuntime({ mailer: { async send(message) { messages.push(message) } } })
    await holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com/base/').sendEmailVerification(verification)
    await holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { messages.push(mail) } }, 'https://example.com/base/').sendEmailVerification(verification)

    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.subject).toBe('Verify your email address')
      expect(message.html).toContain('Hello Ava &lt;&amp;&quot;&#39;&gt;,')
      expect(message.html).toContain('https://example.com/base/verify?source=email&amp;token=a%26b+%2B%2F%23#finish')
      expect(message.html).toContain('October 8, 2026 at 12:30 PM UTC')
      expect(message.metadata).toEqual({ provider: 'users', tokenId: 'token-id' })
    }
    expect(messages[1]?.html).toBe(messages[0]?.html)
    expect(messages[1]?.text).toContain('Hello Ava <&"\'>,')
    expect(messages[1]?.text).toContain('Verify email address: https://example.com/base/verify?source=email&token=a%26b+%2B%2F%23#finish')
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
  build: { email(input) { return { subject: 'Project verification', text: input.url, metadata: { custom: true, name: input.name } } } },
}
export default { via() { return ['email'] }, build: { email() { return { subject: 'Wrong export' } } } }
`)
    await delivery.sendEmailVerification(verification)
    expect(messages[0]?.subject).toBe('Verify your email address')
    expect(messages[1]).toEqual({ subject: 'Project verification', text: 'https://example.com/verify?source=email&token=a%26b+%2B%2F%23#finish', metadata: { custom: true, name: 'Ava <&"\'>' } })
    await holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { messages.push(mail) } }, 'https://example.com').sendEmailVerification(verification)
    expect(messages[2]?.subject).toBe('Verify your email address')
  })

  it.each([{ name: '   ' }, { name: 42 }, null])('omits unusable verification names for %j', async (user) => {
    const sent: Parameters<Parameters<typeof holoRuntimeInternals.createAuthMailDeliveryHook>[0]['sendMail']>[0][] = []
    const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) { sent.push(mail) } }, 'https://example.com')
    await delivery.sendEmailVerification({ ...verification, user })
    expect(sent[0]?.to).toEqual({ email: 'ava@example.com' })
    expect(sent[0]?.text).not.toContain('Hello')
  })

  it('delivers password reset content without a recipient name or broker metadata', async () => {
    const messages: DeliveredMessage[] = []
    const input = { broker: 'admins', provider: 'users', email: 'ava@example.com', token, route: '/reset-password' }
    configureNotificationsRuntime({ mailer: { async send(message, context) {
      expect(context.route).toEqual({ email: 'ava@example.com' })
      messages.push(message)
    } } })
    await holoRuntimeInternals.createAuthNotificationsDeliveryHook({ defineNotification, notify }, 'https://example.com').sendPasswordReset(input)
    await holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail(mail) {
      expect(mail.to).toBe('ava@example.com')
      messages.push(mail)
    } }, 'https://example.com').sendPasswordReset(input)
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message.subject).toBe('Reset your password')
      expect(message.html).toContain('Click the link below to choose a new password.')
      expect(message.html).toContain('This reset link expires at October 8, 2026 at 12:30 PM UTC.')
      expect(message.html).toContain('Reset password</a>')
      expect(message.metadata).toEqual({ provider: 'users', tokenId: 'token-id' })
    }
    expect(messages[1]?.html).toBe(messages[0]?.html)
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
    await expect(delivery.sendPasswordReset({ ...verification, broker: 'users' })).rejects.toThrow('Auth notification file "server/notifications/auth/password-reset.mjs" must export a notification definition.')
  })

  it('preserves Notifications transport failure handling without retrying through Mail', async () => {
    const failure = new Error('Transport unavailable')
    let notificationsAttempts = 0
    let mailAttempts = 0
    configureNotificationsRuntime({ mailer: { async send() { notificationsAttempts++; throw failure } } })
    const delivery = createCoreAuthDeliveryHook({
      appUrl: 'https://example.com',
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
    const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail() { throw failure } }, 'https://example.com')
    await expect(delivery.sendEmailVerification(verification)).rejects.toBe(failure)
  })
})
