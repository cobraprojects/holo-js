import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MailAppIdentity } from '@holo-js/mail'
import type { NotificationBuildContext, NotificationDefinition, NotificationMailMessage, defineNotification, notify, NotificationMailSender } from '@holo-js/notifications'
import { importBundledRuntimeModule } from '../runtimeModule'
import { createAuthActionUrl, sendNotificationMail } from './authMailDelivery'

type NotificationsModule = { readonly defineNotification: typeof defineNotification, readonly notify: typeof notify }
type MailSender = Parameters<typeof sendNotificationMail>[0]
type AuthEmailPurpose = 'email-verification' | 'password-reset'
type AuthDeliveryInput = {
  readonly provider: string
  readonly email: string
  readonly token: { readonly id: string, readonly plainTextToken: string, readonly createdAt: Date, readonly expiresAt: Date }
  readonly route: string
}
type AuthEmailRecipient = {
  readonly email: string
  readonly name?: string
  readonly url: string
  readonly expiresInMinutes: number
}
type AuthEmail = {
  readonly purpose: AuthEmailPurpose
  readonly recipient: AuthEmailRecipient
  readonly message: NotificationMailMessage
}

function createEmailVerificationMessage(url: string): NotificationMailMessage {
  return {
    subject: 'Verify Email Address',
    lines: ['Please click the button below to verify your email address.'],
    action: { label: 'Verify Email Address', url },
    outroLines: ['If you did not create an account, no further action is required.'],
  }
}

function createPasswordResetMessage(url: string, expiresInMinutes: number): NotificationMailMessage {
  return {
    subject: 'Reset Password Notification',
    lines: ['You are receiving this email because we received a password reset request for your account.'],
    action: { label: 'Reset Password', url },
    outroLines: [
      `This password reset link will expire in ${expiresInMinutes} minutes.`,
      'If you did not request a password reset, no further action is required.',
    ],
  }
}

function resolveTokenLifetimeInMinutes(token: AuthDeliveryInput['token']): number {
  return Math.round((token.expiresAt.getTime() - token.createdAt.getTime()) / 60_000)
}

function composeAuthEmail(purpose: AuthEmailPurpose, input: AuthDeliveryInput, appUrl: string, name?: string): AuthEmail {
  const url = createAuthActionUrl(appUrl, input.route, input.token.plainTextToken)
  const expiresInMinutes = resolveTokenLifetimeInMinutes(input.token)
  const message = purpose === 'email-verification'
    ? createEmailVerificationMessage(url)
    : createPasswordResetMessage(url, expiresInMinutes)
  return {
    purpose,
    recipient: Object.freeze({ email: input.email, ...(name ? { name } : {}), url, expiresInMinutes }),
    message: { ...message, metadata: { provider: input.provider, tokenId: input.token.id } },
  }
}

function hasStringName(user: unknown): user is { readonly name: string } {
  return typeof user === 'object' && user !== null && 'name' in user && typeof user.name === 'string'
}

function resolveRecipientName(user: unknown): string | undefined {
  return hasStringName(user) ? user.name.trim() || undefined : undefined
}

function createAuthDeliveryHook(appUrl: string, send: (email: AuthEmail) => Promise<void>) {
  return Object.freeze({
    async sendEmailVerification(input: AuthDeliveryInput & { readonly user: unknown }): Promise<void> {
      await send(composeAuthEmail('email-verification', input, appUrl, resolveRecipientName(input.user)))
    },
    async sendPasswordReset(input: AuthDeliveryInput & { readonly broker: string }): Promise<void> {
      await send(composeAuthEmail('password-reset', input, appUrl))
    },
  })
}

export function createAuthMailDeliveryHook(mail: MailSender, app: MailAppIdentity, projectRoot?: string) {
  return createAuthDeliveryHook(app.url, async ({ purpose, recipient, message }) => {
    const projectNotification = await loadProjectAuthNotification(projectRoot, purpose)
    const to = { email: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) }
    await sendNotificationMail(
      mail,
      app.name,
      to,
      projectNotification ? projectNotification.build.email(recipient, { channel: 'email', anonymous: false }) : message,
    )
  })
}

export function createAuthNotificationsDeliveryHook(notifications: NotificationsModule, appUrl: string, projectRoot?: string) {
  return createAuthDeliveryHook(appUrl, async ({ purpose, recipient, message }) => {
    const notification = await loadProjectAuthNotification(projectRoot, purpose) ?? notifications.defineNotification({
      type: `auth.${purpose}`,
      via() { return ['email'] },
      build: {
        email() { return message },
      },
    })
    await notifications.notify(recipient, notification)
  })
}

export function createCoreAuthDeliveryHook(options: {
  readonly app: MailAppIdentity
  readonly projectRoot?: string
  readonly notifications?: NotificationsModule
  readonly mail?: MailSender
  readonly notificationsMailer?: NotificationMailSender
}) {
  if (options.notifications && (options.mail || options.notificationsMailer)) {
    return createAuthNotificationsDeliveryHook(options.notifications, options.app.url, options.projectRoot)
  }
  return options.mail ? createAuthMailDeliveryHook(options.mail, options.app, options.projectRoot) : undefined
}

type AuthNotificationModule = {
  readonly default?: unknown
  readonly notification?: unknown
  readonly emailVerificationNotification?: unknown
  readonly passwordResetNotification?: unknown
}
type AuthNotification = NotificationDefinition<AuthEmailRecipient, {
  readonly email: (recipient: AuthEmailRecipient, context: NotificationBuildContext<'email'>) => NotificationMailMessage
}>

const AUTH_NOTIFICATION_EXTENSIONS = ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'] as const
const AUTH_NOTIFICATION_EXPORTS = {
  'email-verification': 'emailVerificationNotification',
  'password-reset': 'passwordResetNotification',
} as const satisfies Record<AuthEmailPurpose, keyof AuthNotificationModule>

function resolveExistingAuthNotificationFile(projectRoot: string, purpose: AuthEmailPurpose): string | undefined {
  return AUTH_NOTIFICATION_EXTENSIONS
    .map(extension => `server/notifications/auth/${purpose}.${extension}`)
    .find(candidate => existsSync(resolve(projectRoot, candidate)))
}

function isAuthNotification(notification: unknown): notification is AuthNotification {
  if (!notification || typeof notification !== 'object') {
    return false
  }

  const candidate = notification as { readonly via?: unknown, readonly build?: { readonly email?: unknown } }
  return typeof candidate.via === 'function' && typeof candidate.build?.email === 'function'
}

async function loadProjectAuthNotification(projectRoot: string | undefined, purpose: AuthEmailPurpose): Promise<AuthNotification | undefined> {
  const filePath = projectRoot ? resolveExistingAuthNotificationFile(projectRoot, purpose) : undefined
  if (!projectRoot || !filePath) {
    return undefined
  }

  const module = await importBundledRuntimeModule(projectRoot, filePath) as AuthNotificationModule
  const notification = module[AUTH_NOTIFICATION_EXPORTS[purpose]] ?? module.notification ?? module.default
  if (!isAuthNotification(notification)) {
    throw new Error(`[@holo-js/core] Auth notification file "${filePath}" must export a notification definition with an email message.`)
  }

  return notification
}
