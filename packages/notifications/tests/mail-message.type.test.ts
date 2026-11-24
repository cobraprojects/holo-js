import { describe, it } from 'vitest'
import { defineNotification, type NotificationMailMessage } from '../src'

declare module '@holo-js/mail' {
  interface HoloMailTemplateRegistry {
    readonly 'invoices/paid': { readonly invoice: { readonly id: string | number } }
    readonly 'welcome': Record<string, never>
  }
}

describe('@holo-js/notifications mail message typing', () => {
  it('types markdown and data by the generated Mail template registry', () => {
    defineNotification({
      via: () => ['email'],
      build: {
        email: () => ({ subject: 'Paid', markdown: 'invoices/paid', data: { invoice: { id: 7 } } }),
      },
    })

    const lineMessage: NotificationMailMessage = {
      subject: 'Paid',
      level: 'success',
      greeting: 'Hi',
      lines: ['Paid.'],
      action: { label: 'View', url: 'https://example.com' },
      outroLines: ['Thanks.'],
      salutation: 'Bye',
    }
    const welcome: NotificationMailMessage = { subject: 'Welcome', markdown: 'welcome' }
    void lineMessage
    void welcome

    if (false) {
      // @ts-expect-error Unknown Mail template names are rejected.
      void ({ subject: 'Typo', markdown: 'invoices/payed', data: {} } satisfies NotificationMailMessage)
      // @ts-expect-error Template data must match the Mail template.
      void ({ subject: 'Paid', markdown: 'invoices/paid', data: { invoice: { id: true } } } satisfies NotificationMailMessage)
      // @ts-expect-error Required template data cannot be omitted.
      void ({ subject: 'Paid', markdown: 'invoices/paid' } satisfies NotificationMailMessage)
      // @ts-expect-error Levels are limited to info, success, and error.
      void ({ subject: 'Paid', level: 'warning' } satisfies NotificationMailMessage)
    }
  })

  it('rejects greeting, lines, action, outro lines, and salutation alongside markdown', () => {
    const template = { subject: 'Paid', markdown: 'invoices/paid', data: { invoice: { id: 7 } } } as const
    if (false) {
      // @ts-expect-error A custom Mail template replaces the greeting.
      void ({ ...template, greeting: 'Hi' } satisfies NotificationMailMessage)
      // @ts-expect-error A custom Mail template replaces the intro lines.
      void ({ ...template, lines: ['Paid.'] } satisfies NotificationMailMessage)
      // @ts-expect-error A custom Mail template replaces the Mail action.
      void ({ ...template, action: { label: 'View', url: 'https://example.com' } } satisfies NotificationMailMessage)
      // @ts-expect-error A custom Mail template replaces the outro lines.
      void ({ ...template, outroLines: ['Thanks.'] } satisfies NotificationMailMessage)
      // @ts-expect-error A custom Mail template replaces the salutation.
      void ({ ...template, salutation: 'Bye' } satisfies NotificationMailMessage)
    }
  })
})
