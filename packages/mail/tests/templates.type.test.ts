import { describe, it } from 'vitest'
import {
  defineMail,
  sendMail,
  type MailDefinition,
  type MailTemplateData,
  type MailTemplateName,
} from '../src'

declare module '../src/contracts' {
  interface HoloMailTemplateRegistry {
    readonly 'welcome': Record<string, never>
    readonly 'orders/shipped': {
      readonly customer: { readonly name: string | number }
      readonly orderId: string | number
    }
  }
}

describe('@holo-js/mail template typing', () => {
  it('types markdown as a generated Mail template name and data by that template', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const shipped = defineMail({
      to: 'ava@example.com',
      subject: 'Shipped',
      markdown: 'orders/shipped',
      data: { customer: { name: 'Ava' }, orderId: 42 },
    })
    const welcome = defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: 'welcome',
    })

    type NameAssertion = Expect<Equal<MailTemplateName, 'welcome' | 'orders/shipped'>>
    type DataAssertion = Expect<Equal<MailTemplateData<'orders/shipped'>['customer'], { readonly name: string | number }>>
    type DefinitionAssertion = Expect<Equal<typeof shipped, MailDefinition>>

    if (false) {
      void sendMail({
        to: 'ava@example.com',
        subject: 'Shipped',
        markdown: 'orders/shipped',
        data: { customer: { name: 'Ava' }, orderId: '42' },
      })

      // @ts-expect-error Unknown Mail template names are rejected.
      defineMail({ to: 'ava@example.com', subject: 'Typo', markdown: 'orders/shiped' })

      defineMail({
        to: 'ava@example.com',
        subject: 'Shipped',
        markdown: 'orders/shipped',
        // @ts-expect-error A data value the template uses is missing.
        data: { customer: { name: 'Ava' } },
      })

      defineMail({
        to: 'ava@example.com',
        subject: 'Shipped',
        markdown: 'orders/shipped',
        // @ts-expect-error Template values must be strings or numbers.
        data: { customer: { name: 'Ava' }, orderId: true },
      })

      defineMail({
        to: 'ava@example.com',
        subject: 'Shipped',
        markdown: 'orders/shipped',
        // @ts-expect-error Dates must be formatted before they are passed to a template.
        data: { customer: { name: 'Ava' }, orderId: new Date() },
      })

      // @ts-expect-error A Mail template is the only content source of a markdown mail.
      defineMail({ to: 'ava@example.com', subject: 'Both', markdown: 'welcome', html: '<p>Hi</p>' })

      // @ts-expect-error Data is only valid with a Mail template.
      defineMail({ to: 'ava@example.com', subject: 'Html', html: '<p>Hi</p>', data: { name: 'Ava' } })
    }

    void welcome
    void (0 as unknown as NameAssertion)
    void (0 as unknown as DataAssertion)
    void (0 as unknown as DefinitionAssertion)
  })
})
