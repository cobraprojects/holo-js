import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NotificationDefinition, defineNotification, notify, NotificationMailSender } from '@holo-js/notifications'
import { importBundledRuntimeModule } from '../runtimeModule'
import { createAuthActionUrl, createAuthEmailHtml, type createCoreNotificationMailSender, createNotificationMailText, formatAuthEmailExpiration } from './authMailDelivery'

type NotificationsModule = { readonly defineNotification: typeof defineNotification, readonly notify: typeof notify }
type MailSender = Parameters<typeof createCoreNotificationMailSender>[0]
type AuthDeliveryInput = {
  readonly provider: string
  readonly email: string
  readonly token: { readonly id: string, readonly plainTextToken: string, readonly expiresAt: Date }
  readonly route: string
}

const authEmailContent = {
  'email-verification': {
    subject: 'Verify your email address',
    introduction: 'Confirm your account to finish signing in.',
    expiration: 'This verification link expires at',
    actionLabel: 'Verify email address',
  },
  'password-reset': {
    subject: 'Reset your password',
    introduction: 'Click the link below to choose a new password.',
    expiration: 'This reset link expires at',
    actionLabel: 'Reset password',
  },
} as const

type AuthEmailPurpose = keyof typeof authEmailContent

function composeAuthEmail(purpose: AuthEmailPurpose, input: AuthDeliveryInput, appUrl: string, name?: string) {
  const content = authEmailContent[purpose]
  const url = createAuthActionUrl(appUrl, input.route, input.token.plainTextToken)
  return {
    purpose,
    recipient: Object.freeze({ email: input.email, ...(name ? { name } : {}), url, expiresAt: input.token.expiresAt }),
    message: {
      subject: content.subject,
      ...(name ? { greeting: `Hello ${name},` } : {}),
      lines: [content.introduction, `${content.expiration} ${formatAuthEmailExpiration(input.token.expiresAt)}.`],
      action: { label: content.actionLabel, url },
      metadata: { provider: input.provider, tokenId: input.token.id },
    },
  }
}

function createAuthDeliveryHook(appUrl: string, send: (delivery: ReturnType<typeof composeAuthEmail>) => Promise<void>) {
  return Object.freeze({
    async sendEmailVerification(input: AuthDeliveryInput & { readonly user: unknown }): Promise<void> {
      const recipientName = typeof (input.user as { name?: unknown })?.name === 'string'
        ? (input.user as { name?: string }).name?.trim()
        : undefined
      await send(composeAuthEmail('email-verification', input, appUrl, recipientName))
    },
    async sendPasswordReset(input: AuthDeliveryInput & { readonly broker: string }): Promise<void> {
      await send(composeAuthEmail('password-reset', input, appUrl))
    },
  })
}

export function createAuthMailDeliveryHook(mail: MailSender, appUrl: string) {
  return createAuthDeliveryHook(appUrl, async ({ purpose, recipient, message }) => {
    await mail.sendMail({
      to: purpose === 'email-verification'
        ? { email: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) }
        : recipient.email,
      subject: message.subject,
      html: createAuthEmailHtml(message),
      text: createNotificationMailText(message),
      metadata: message.metadata,
    })
  })
}

export function createAuthNotificationsDeliveryHook(notifications: NotificationsModule, appUrl: string, projectRoot?: string) {
  return createAuthDeliveryHook(appUrl, async ({ purpose, recipient, message }) => {
    const projectNotification = await loadProjectAuthNotification(
      projectRoot,
      purpose === 'email-verification' ? AUTH_EMAIL_VERIFICATION_NOTIFICATION_PATHS : AUTH_PASSWORD_RESET_NOTIFICATION_PATHS,
      purpose === 'email-verification' ? 'emailVerificationNotification' : 'passwordResetNotification',
    )
    const notification = projectNotification ?? notifications.defineNotification({
      type: `auth.${purpose}`,
      via() { return ['email'] },
      build: {
        email() { return { ...message, html: createAuthEmailHtml(message) } },
      },
    })
    await notifications.notify(recipient, notification)
  })
}

export function createCoreAuthDeliveryHook(options: {
  readonly appUrl: string
  readonly projectRoot?: string
  readonly notifications?: NotificationsModule
  readonly mail?: MailSender
  readonly notificationsMailer?: NotificationMailSender
}) {
  if (options.notifications && (options.mail || options.notificationsMailer)) {
    return createAuthNotificationsDeliveryHook(options.notifications, options.appUrl, options.projectRoot)
  }
  return options.mail ? createAuthMailDeliveryHook(options.mail, options.appUrl) : undefined
}

type AuthNotificationModule = {
  readonly default?: unknown
  readonly notification?: unknown
  readonly emailVerificationNotification?: unknown
  readonly passwordResetNotification?: unknown
}

const AUTH_EMAIL_VERIFICATION_NOTIFICATION_PATHS = [
  'server/notifications/auth/email-verification.ts',
  'server/notifications/auth/email-verification.mts',
  'server/notifications/auth/email-verification.js',
  'server/notifications/auth/email-verification.mjs',
  'server/notifications/auth/email-verification.cts',
  'server/notifications/auth/email-verification.cjs',
] as const

const AUTH_PASSWORD_RESET_NOTIFICATION_PATHS = [
  'server/notifications/auth/password-reset.ts',
  'server/notifications/auth/password-reset.mts',
  'server/notifications/auth/password-reset.js',
  'server/notifications/auth/password-reset.mjs',
  'server/notifications/auth/password-reset.cts',
  'server/notifications/auth/password-reset.cjs',
] as const

function resolveExistingProjectFile(projectRoot: string | undefined, candidates: readonly string[]): string | undefined {
  if (!projectRoot) {
    return undefined
  }

  return candidates.find(candidate => existsSync(resolve(projectRoot, candidate)))
}

function resolveAuthNotification(
  module: AuthNotificationModule,
  exportName: 'emailVerificationNotification' | 'passwordResetNotification',
  filePath: string,
): NotificationDefinition {
  const notification = module[exportName] ?? module.notification ?? module.default
  if (!isAuthNotificationDefinition(notification)) {
    throw new Error(
      `[@holo-js/core] Auth notification file "${filePath}" must export a notification definition.`,
    )
  }

  return notification
}

function isAuthNotificationDefinition(notification: unknown): notification is NotificationDefinition {
  if (!notification || typeof notification !== 'object') {
    return false
  }

  const candidate = notification as {
    readonly via?: unknown
    readonly build?: unknown
  }
  if (typeof candidate.via !== 'function' || !candidate.build || typeof candidate.build !== 'object') {
    return false
  }

  return Object.values(candidate.build).some(factory => typeof factory === 'function')
}

async function loadProjectAuthNotification(
  projectRoot: string | undefined,
  candidates: readonly string[],
  exportName: 'emailVerificationNotification' | 'passwordResetNotification',
): Promise<NotificationDefinition | undefined> {
  const filePath = resolveExistingProjectFile(projectRoot, candidates)
  if (!filePath) {
    return undefined
  }

  const module = await importBundledRuntimeModule(projectRoot!, filePath) as AuthNotificationModule
  return resolveAuthNotification(module, exportName, filePath)
}
