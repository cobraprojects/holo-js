type MailSender = {
  sendMail(mail: {
    readonly to: unknown
    readonly subject: string
    readonly text?: string
    readonly html?: string
    readonly metadata?: Readonly<Record<string, unknown>>
  }): PromiseLike<unknown>
}

type NotificationMailMessage = {
  readonly subject: string
  readonly greeting?: string
  readonly lines?: readonly string[]
  readonly action?: {
    readonly label: string
    readonly url: string
  }
  readonly html?: string
  readonly text?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

const authEmailDateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'UTC',
})

export function formatAuthEmailExpiration(expiresAt: Date): string {
  return `${authEmailDateFormatter.format(expiresAt)} UTC`
}

export function escapeAuthEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

export function createNotificationMailText(message: Omit<NotificationMailMessage, 'subject'>): string | undefined {
  const parts = [
    typeof message.greeting === 'string' ? message.greeting.trim() : undefined,
    ...(message.lines ?? []).map(line => line.trim()).filter(Boolean),
    message.action ? `${message.action.label}: ${message.action.url}` : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

export function createNotificationMailHtml(message: NotificationMailMessage): string {
  const greeting = typeof message.greeting === 'string' ? message.greeting.trim() : undefined
  const lines = (message.lines ?? []).map(line => line.trim()).filter(Boolean)
  const sections = [
    greeting ? `<p style="margin:0 0 16px;">${escapeAuthEmailHtml(greeting)}</p>` : '',
    ...lines.map(line => `<p style="margin:0 0 16px;">${escapeAuthEmailHtml(line)}</p>`),
    message.action
      ? `<p style="margin:24px 0;"><a href="${escapeAuthEmailHtml(message.action.url)}" style="display:inline-block;padding:12px 18px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${escapeAuthEmailHtml(message.action.label)}</a></p>`
      : '',
    message.action
      ? `<p style="margin:0;color:#475569;font-size:14px;">If the button does not work, open this link: <a href="${escapeAuthEmailHtml(message.action.url)}">${escapeAuthEmailHtml(message.action.url)}</a></p>`
      : '',
  ].join('')

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${escapeAuthEmailHtml(message.subject)}</title>`,
    '</head><body style="margin:0;padding:24px;font-family:Arial,sans-serif;color:#0f172a;background:#f8fafc;">',
    '<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;">',
    `<h1 style="margin:0 0 24px;font-size:24px;line-height:1.3;">${escapeAuthEmailHtml(message.subject)}</h1>`,
    sections,
    '</div></body></html>',
  ].join('')
}

export function createAuthActionUrl(appUrl: string, path: string, token: string): string {
  const normalizedBaseUrl = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${normalizedBaseUrl}${normalizedPath}`)
  url.searchParams.set('token', token)
  return url.toString()
}

export function createAuthEmailHtml(message: NotificationMailMessage & {
  readonly lines: readonly string[]
  readonly action: { readonly label: string, readonly url: string }
}): string {
  return createNotificationMailHtml(message)
}

export function createCoreNotificationMailSender(mailModule: MailSender): {
  send(message: NotificationMailMessage, context: {
    readonly route?: string | { readonly email: string, readonly name?: string }
  }): Promise<void>
} {
  return Object.freeze({
    async send(message, context): Promise<void> {
      if (!context.route) {
        throw new Error('[@holo-js/core] Email notifications require a resolved email route before bridging into mail.')
      }
      const fallbackText = createNotificationMailText(message)
      await mailModule.sendMail({
        to: context.route,
        subject: message.subject,
        html: typeof message.html === 'string' ? message.html : createNotificationMailHtml(message),
        ...(typeof (message.text ?? fallbackText) === 'string' ? { text: message.text ?? fallbackText } : {}),
        ...(message.metadata ? { metadata: message.metadata } : {}),
      })
    },
  })
}

export function createAuthMailDeliveryHook(mailModule: MailSender, appUrl: string) {
  return Object.freeze({
    async sendEmailVerification(input: {
      readonly provider: string
      readonly user: unknown
      readonly email: string
      readonly token: { readonly id: string, readonly plainTextToken: string, readonly expiresAt: Date }
      readonly route: string
    }): Promise<void> {
      const recipientName = typeof (input.user as { name?: unknown })?.name === 'string'
        ? (input.user as { name?: string }).name?.trim()
        : undefined
      const lines = [
        'Confirm your account to finish signing in.',
        `This verification link expires at ${formatAuthEmailExpiration(input.token.expiresAt)}.`,
      ] as const
      const action = {
        label: 'Verify email address',
        url: createAuthActionUrl(appUrl, input.route, input.token.plainTextToken),
      } as const
      await mailModule.sendMail({
        to: { email: input.email, ...(recipientName ? { name: recipientName } : {}) },
        subject: 'Verify your email address',
        html: createAuthEmailHtml({
          subject: 'Verify your email address',
          ...(recipientName ? { greeting: `Hello ${recipientName},` } : {}),
          lines,
          action,
        }),
        text: createNotificationMailText({
          ...(recipientName ? { greeting: `Hello ${recipientName},` } : {}),
          lines,
          action,
        }),
        metadata: { provider: input.provider, tokenId: input.token.id },
      })
    },
    async sendPasswordReset(input: {
      readonly broker: string
      readonly provider: string
      readonly email: string
      readonly token: { readonly id: string, readonly plainTextToken: string, readonly expiresAt: Date }
      readonly route: string
    }): Promise<void> {
      const lines = [
        'Click the link below to choose a new password.',
        `This reset link expires at ${formatAuthEmailExpiration(input.token.expiresAt)}.`,
      ] as const
      const action = {
        label: 'Reset password',
        url: createAuthActionUrl(appUrl, input.route, input.token.plainTextToken),
      } as const
      await mailModule.sendMail({
        to: input.email,
        subject: 'Reset your password',
        html: createAuthEmailHtml({ subject: 'Reset your password', lines, action }),
        text: createNotificationMailText({ lines, action }),
        metadata: { provider: input.provider, tokenId: input.token.id },
      })
    },
  })
}
