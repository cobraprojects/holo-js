import { describe, it } from 'vitest'
import {
  attachContent,
  attachFromPath,
  attachFromStorage,
  defineMail,
  previewMail,
  renderMailPreview,
  sendMail,
  type MailAddress,
  type MailDefinition,
  type MailDriver,
  type MailDriverName,
  type MailPreviewResult,
} from '../src'

declare module '../src/contracts' {
  interface HoloMailDriverRegistry {
    readonly resend: MailDriver
  }
}

describe('@holo-js/mail typing', () => {
  it('preserves mail, attachment, and pending-send inference', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const mail = defineMail({
      to: [{ email: 'ava@example.com', name: 'Ava' }],
      subject: 'Welcome',
      markdown: '# Welcome',
      attachments: [
        attachFromPath('/tmp/report.pdf'),
        attachFromStorage('reports/invoice.pdf', { disk: 'public' }),
        attachContent('body', { name: 'welcome.txt' }),
      ],
    })

    const pending = sendMail(mail).using('preview').onQueue('mail').afterCommit()
    const rawPending = sendMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    }, {
      tags: ['transactional'],
    })

    const driverName: MailDriverName = 'resend'
    const firstRecipient: MailAddress = mail.to[0]!
    const preview: Promise<MailPreviewResult> = 0 as unknown as Promise<MailPreviewResult>
    const previewFromRaw: Promise<MailPreviewResult> = 0 as unknown as Promise<MailPreviewResult>
    const renderedPreview: Promise<Response> = 0 as unknown as Promise<Response>

    type MailAssertion = Expect<Equal<typeof mail, MailDefinition>>

    if (false) {
      void previewMail(mail)
      void previewMail({
        to: 'ava@example.com',
        subject: 'Welcome',
        markdown: '# Welcome',
      })
      void renderMailPreview(mail)
    }

    // @ts-expect-error Invalid attachment content helper usage requires a name.
    attachContent('body', {})

    if (false) {
      // @ts-expect-error A mail definition requires a recipient.
      defineMail({
        subject: 'Missing recipient',
        markdown: '# Welcome',
      })
    }

    void pending
    void rawPending
    void driverName
    void firstRecipient
    void preview
    void previewFromRaw
    void renderedPreview
    void (0 as unknown as MailAssertion)
  })
})
