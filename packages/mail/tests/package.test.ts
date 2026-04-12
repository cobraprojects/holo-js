import { afterEach, describe, expect, it } from 'vitest'
import * as mailExports from '../src'
import mail, {
  attachContent,
  attachFromPath,
  attachFromStorage,
  defineMail,
  defineMailConfig,
  listFakeSentMails,
  listRegisteredMailDrivers,
  listPreviewMailArtifacts,
  previewMail,
  registerMailDriver,
  renderMailPreview,
  resetFakeSentMails,
  resetMailDriverRegistry,
  resetMailRuntime,
  resetPreviewMailArtifacts,
  sendMail,
} from '../src'

afterEach(() => {
  resetMailDriverRegistry()
  resetMailRuntime()
})

describe('@holo-js/mail package surface', () => {
  it('exports the package helpers and config helper', () => {
    const definition = defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    })

    expect(typeof mail.sendMail).toBe('function')
    expect(typeof mail.previewMail).toBe('function')
    expect(typeof mail.renderMailPreview).toBe('function')
    expect(defineMailConfig({
      default: 'preview',
    })).toEqual({
      default: 'preview',
    })
    expect(typeof sendMail(definition).then).toBe('function')
    expect(typeof previewMail).toBe('function')
    expect(typeof renderMailPreview).toBe('function')
    expect(typeof listFakeSentMails).toBe('function')
    expect(typeof resetFakeSentMails).toBe('function')
    expect(typeof listPreviewMailArtifacts).toBe('function')
    expect(typeof resetPreviewMailArtifacts).toBe('function')
    expect(attachFromPath('/tmp/report.pdf')).toEqual({
      path: '/tmp/report.pdf',
    })
    expect(attachFromStorage('reports/invoice.pdf')).toEqual({
      storage: {
        path: 'reports/invoice.pdf',
      },
    })
    expect(attachContent('body', { name: 'welcome.txt' })).toEqual({
      content: 'body',
      name: 'welcome.txt',
    })
    expect(() => registerMailDriver('resend', {
      send() {
        return {
          messageId: 'mail-1',
          mailer: 'resend',
          driver: 'resend',
          queued: false,
        }
      },
    })).not.toThrow()
    expect(listRegisteredMailDrivers()).toHaveLength(1)
    expect(() => registerMailDriver('   ' as never, {
      send() {
        return {
          messageId: 'mail-2',
          mailer: 'resend',
          driver: 'resend',
          queued: false,
        }
      },
    })).toThrow('must be non-empty strings')
    expect('createTransport' in mailExports).toBe(false)
    expect('nodemailer' in mailExports).toBe(false)
  })
})
