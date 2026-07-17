import type { MailPreviewFormat, MailPreviewPolicy } from './contracts'

export class MailError extends Error {
  readonly code: string

  constructor(message: string, code = 'MAIL_ERROR', options?: ErrorOptions) {
    super(message, options)
    this.name = 'MailError'
    this.code = code
  }
}

export class MailPreviewDisabledError extends MailError {
  readonly policy: MailPreviewPolicy

  constructor(policy: MailPreviewPolicy) {
    super(
      `[@holo-js/mail] Mail preview is disabled for the "${policy.environment}" environment.`,
      'MAIL_PREVIEW_DISABLED',
    )
    this.name = 'MailPreviewDisabledError'
    this.policy = policy
  }
}

export class MailPreviewFormatUnavailableError extends MailError {
  readonly format: MailPreviewFormat

  constructor(format: MailPreviewFormat) {
    super(
      `[@holo-js/mail] Mail ${format} preview is unavailable for this message.`,
      'MAIL_PREVIEW_FORMAT_UNAVAILABLE',
    )
    this.name = 'MailPreviewFormatUnavailableError'
    this.format = format
  }
}

export class MailSendError extends MailError {
  readonly messageId: string
  readonly mailer: string
  readonly driver: string

  constructor(
    details: {
      readonly messageId: string
      readonly mailer: string
      readonly driver: string
      readonly message?: string
    },
    options?: ErrorOptions,
  ) {
    super(
      details.message
        ?? `[@holo-js/mail] Mail delivery failed for mailer "${details.mailer}" using driver "${details.driver}".`,
      'MAIL_SEND_FAILED',
      options,
    )
    this.name = 'MailSendError'
    this.messageId = details.messageId
    this.mailer = details.mailer
    this.driver = details.driver
  }
}
