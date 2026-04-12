import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readMailDoc(name: string): Promise<string> {
  return readFile(resolve(root, 'apps/docs/docs/mail', name), 'utf8')
}

describe('mail documentation smoke checks', () => {
  it('covers the overview and package boundaries', async () => {
    const overview = await readMailDoc('index.md')

    expect(overview).toContain('@holo-js/mail')
    expect(overview).toContain('defineMail(...)')
    expect(overview).toContain('sendMail(...)')
    expect(overview).toContain('previewMail(...)')
    expect(overview).toContain('renderMailPreview(...)')
    expect(overview).toContain('preview')
    expect(overview).toContain('log')
    expect(overview).toContain('fake')
    expect(overview).toContain('smtp')
    expect(overview).toContain('@holo-js/queue')
    expect(overview).toContain('@holo-js/core')
  })

  it('covers install flow, generator flow, and auth integration', async () => {
    const setup = await readMailDoc('setup-and-cli.md')
    const installation = await readFile(resolve(root, 'apps/docs/docs/installation.md'), 'utf8')
    const verification = await readFile(resolve(root, 'apps/docs/docs/auth/email-verification.md'), 'utf8')
    const reset = await readFile(resolve(root, 'apps/docs/docs/auth/password-reset.md'), 'utf8')

    expect(setup).toContain('bunx holo install mail')
    expect(setup).toContain('config/mail.ts')
    expect(setup).toContain('server/mail/')
    expect(setup).toContain('bunx holo make:mail auth/verify-email')
    expect(setup).toContain('--markdown')
    expect(setup).toContain('custom `renderView` runtime binding')
    expect(installation).toContain('mail')
    expect(installation).toContain('--package forms,validation,mail')
    expect(verification).toContain('bunx holo install mail')
    expect(reset).toContain('@holo-js/mail')
  })

  it('covers final mail authoring, preview, and attachment APIs', async () => {
    const defining = await readMailDoc('defining-mail.md')
    const sending = await readMailDoc('sending-and-preview.md')
    const attachments = await readMailDoc('attachments-and-drivers.md')

    expect(defining).toContain('defineMail({')
    expect(defining).toContain('render: {')
    expect(defining).toContain('markdownWrapper')
    expect(sending).toContain('.using(\'smtp\')')
    expect(sending).toContain('.onQueue(\'mail\')')
    expect(sending).toContain('.delay(300)')
    expect(sending).toContain('.afterCommit()')
    expect(sending).toContain('renderMailPreview')
    expect(attachments).toContain('attachFromPath')
    expect(attachments).toContain('attachFromStorage')
    expect(attachments).toContain('attachContent')
    expect(attachments).toContain('disposition: \'inline\'')
    expect(attachments).toContain('notifications email delivery routes into mail')
  })
})
