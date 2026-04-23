import { describe, it } from 'vitest'
import mail, {
  type MailDefinition,
  type MailPreviewResult,
  type MailSendResult,
  type PendingMailSend,
  attachFromStorage,
  defineMail,
  defineMailConfig,
  previewMail,
  renderMailPreview,
  sendMail,
} from '../src'

describe('@holo-js/mail root export typing', () => {
  it('preserves root-export inference for definitions, preview, and pending sends', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const definition = defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
      attachments: [
        attachFromStorage('reports/invoice.pdf', { disk: 'public' }),
      ],
    })

    const pending = sendMail(definition).using('preview').onQueue('mail')
    const config = defineMailConfig({
      default: 'preview',
      mailers: {
        preview: {
          driver: 'preview',
        },
      },
    })

    type DefinitionAssertion = Expect<Equal<typeof definition, MailDefinition>>
    type PendingAssertion = Expect<Equal<typeof pending, PendingMailSend<MailSendResult>>>

    const preview: Promise<MailPreviewResult> = 0 as unknown as Promise<MailPreviewResult>
    const renderedPreview: Promise<Response> = 0 as unknown as Promise<Response>
    const fromDefault: typeof mail.sendMail = mail.sendMail
    const defaultMailer: string = config.default

    if (false) {
      void previewMail(definition)
      void renderMailPreview(definition)
    }

    void pending
    void preview
    void renderedPreview
    void fromDefault
    void defaultMailer
    void (0 as unknown as DefinitionAssertion)
    void (0 as unknown as PendingAssertion)
  })
})
