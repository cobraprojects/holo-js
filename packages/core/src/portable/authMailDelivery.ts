import type { MailJsonObject, MailRecipientsInput } from '@holo-js/mail'
import type { NotificationEmailRoute, NotificationMailMessage } from '@holo-js/notifications'

type MailContent = {
  readonly text?: string
  readonly html?: string
  readonly markdown?: string
  readonly data?: MailJsonObject
}

type MailSender = {
  sendMail(mail: MailContent & {
    readonly to: MailRecipientsInput
    readonly subject: string
    readonly metadata?: MailJsonObject
  }): PromiseLike<unknown>
}

const NOTIFICATION_MAIL_TEMPLATE = 'notifications/email'

export function createAuthActionUrl(appUrl: string, path: string, token: string): string {
  const normalizedBaseUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${normalizedBaseUrl}${normalizedPath}`)
  url.searchParams.set('token', token)
  return url.toString()
}

function formatNotificationLine(line: string): string {
  return line.split(/\r\n|\r|\n/).map(piece => piece.trim()).join(' ').trim()
}

function createNotificationMailData(message: NotificationMailMessage, appName: string): MailJsonObject {
  const level = message.level ?? 'info'
  return {
    greeting: message.greeting || (level === 'error' ? 'Whoops!' : 'Hello!'),
    level,
    lines: (message.lines ?? []).map(formatNotificationLine),
    ...(message.action ? { action: { label: message.action.label, url: message.action.url } } : {}),
    actionColor: level === 'info' ? 'primary' : level,
    outroLines: (message.outroLines ?? []).map(formatNotificationLine),
    salutation: message.salutation || `Regards,\\\n${appName}`,
  }
}

function resolveNotificationMailContent(message: NotificationMailMessage, appName: string): MailContent {
  if (typeof message.markdown === 'string') {
    return {
      markdown: message.markdown,
      data: message.data ?? {},
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
    }
  }

  if (typeof message.html === 'string' || typeof message.text === 'string') {
    return {
      ...(typeof message.html === 'string' ? { html: message.html } : {}),
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
    }
  }

  return { markdown: NOTIFICATION_MAIL_TEMPLATE, data: createNotificationMailData(message, appName) }
}

export async function sendNotificationMail(
  mailModule: MailSender,
  appName: string,
  to: NotificationEmailRoute,
  message: NotificationMailMessage,
): Promise<void> {
  await mailModule.sendMail({
    to,
    subject: message.subject,
    ...resolveNotificationMailContent(message, appName),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  })
}

export function createCoreNotificationMailSender(mailModule: MailSender, appName: string): {
  send(message: NotificationMailMessage, context: { readonly route?: NotificationEmailRoute }): Promise<void>
} {
  return Object.freeze({
    async send(message, context): Promise<void> {
      if (!context.route) {
        throw new Error('[@holo-js/core] Email notifications require a resolved email route before bridging into mail.')
      }
      await sendNotificationMail(mailModule, appName, context.route, message)
    },
  })
}
