import { describe, expect, it } from 'vitest'
import {
  defineMail,
  isMailDefinition,
  mailInternals,
  normalizeMailDefinition,
} from '../src'

describe('@holo-js/mail contracts', () => {
  it('normalizes and freezes mail definitions', () => {
    const definition = defineMail({
      mailer: ' transactional ',
      from: {
        email: 'NoReply@Example.com ',
        name: ' No Reply ',
      },
      replyTo: ' Support@Example.com ',
      to: [' Ava@Example.com ', 'ava@example.com'],
      cc: 'Team@Example.com',
      bcc: [' Audit@Example.com ', 'audit@example.com'],
      subject: ' Welcome ',
      markdown: '# Welcome',
      markdownWrapper: 'emails/layout',
      attachments: [
        {
          path: '/tmp/report.pdf',
        },
        {
          storage: {
            disk: ' public ',
            path: ' invoices/report.pdf ',
          },
        },
      ],
      headers: {
        ' X-App ': 'holo',
      },
      tags: [' transactional ', 'transactional', ' onboarding '],
      metadata: {
        tenantId: 'tenant-1',
      },
      priority: 'high',
      queue: {
        queued: true,
        connection: ' redis ',
        queue: ' mail ',
        afterCommit: true,
      },
      delay: 30,
    })

    expect(isMailDefinition(definition)).toBe(true)
    expect(definition.mailer).toBe('transactional')
    expect(definition.from).toEqual({
      email: 'noreply@example.com',
      name: 'No Reply',
    })
    expect(definition.replyTo).toEqual({
      email: 'support@example.com',
    })
    expect(definition.to).toEqual([
      {
        email: 'ava@example.com',
      },
    ])
    expect(definition.cc).toEqual([
      {
        email: 'team@example.com',
      },
    ])
    expect(definition.bcc).toEqual([
      {
        email: 'audit@example.com',
      },
    ])
    expect(definition.subject).toBe('Welcome')
    expect(definition.markdownWrapper).toBe('emails/layout')
    expect(definition.attachments).toEqual([
      {
        name: 'report.pdf',
        contentType: 'application/pdf',
        disposition: 'attachment',
        path: '/tmp/report.pdf',
      },
      {
        name: 'report.pdf',
        contentType: 'application/pdf',
        disposition: 'attachment',
        storage: {
          disk: 'public',
          path: 'invoices/report.pdf',
        },
      },
    ])
    expect(definition.headers).toEqual({
      'X-App': 'holo',
    })
    expect(definition.tags).toEqual(['transactional', 'onboarding'])
    expect(definition.queue).toEqual({
      queued: true,
      connection: 'redis',
      queue: 'mail',
      afterCommit: true,
    })
    expect(definition.delay).toBe(30)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.to)).toBe(true)
    expect(Object.isFrozen(definition.attachments)).toBe(true)
  })

  it('rejects malformed definitions and helper inputs', () => {
    expect(() => defineMail({
      to: 'ava@example.com',
      subject: '   ',
      markdown: '# Welcome',
    })).toThrow('Mail subject must be a non-empty string')

    expect(() => defineMail({
      to: [],
      subject: 'Welcome',
      markdown: '# Welcome',
    })).toThrow('Mail to must include at least one recipient')

    expect(() => defineMail({
      to: 'broken',
      subject: 'Welcome',
      markdown: '# Welcome',
    })).toThrow('must be a valid email address')

    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
      html: '<p>Hi</p>',
    })).toThrow('exactly one primary content source')

    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      html: '<p>Hi</p>',
      markdownWrapper: 'emails/layout',
    })).toThrow('markdown wrappers are only valid for markdown mails')

    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      render: {
        view: '../emails/welcome',
      },
    })).toThrow('must not include empty, "." or ".." path segments')

    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
      attachments: [
        {
          content: 'hello',
        } as never,
      ],
    })).toThrow('content attachments must define a name')

    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
      attachments: [
        {
          path: '/tmp/logo.png',
          disposition: 'inline',
        },
      ],
    })).toThrow('Inline attachments must define a contentId')
  })

  it('covers internal helpers, merge behavior, and alternate contract shapes', () => {
    const base = defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
      headers: {
        'X-App': 'base',
      },
      metadata: {
        tenant: 'base',
      },
    })

    const merged = mailInternals.mergeMailDefinitionInputs(base, {
      headers: {
        'X-Trace': 'trace',
      },
      metadata: {
        locale: 'en',
      },
      tags: ['one'],
    })

    expect(normalizeMailDefinition(base)).toBe(base)
    expect(merged.headers).toEqual({
      'X-App': 'base',
      'X-Trace': 'trace',
    })
    expect(merged.metadata).toEqual({
      tenant: 'base',
      locale: 'en',
    })
    expect(mailInternals.normalizeDelayValue(new Date('2026-01-01T00:00:00.000Z'), 'delay')).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    )
    expect(mailInternals.normalizeTags(['one', ' one ', 'two'])).toEqual(['one', 'two'])
    expect(mailInternals.inferAttachmentName({
      path: '/tmp/logo.png',
    })).toBe('logo.png')
    expect(mailInternals.inferAttachmentName({
      storage: {
        path: 'logos/mark.svg',
      },
    })).toBe('mark.svg')
    expect(mailInternals.inferAttachmentName({
      path: '/tmp/',
    })).toBeUndefined()
    expect(mailInternals.inferAttachmentName({
      storage: {
        path: 'logos/',
      },
    })).toBeUndefined()
    expect(mailInternals.inferMimeTypeFromName('logo.png')).toBe('image/png')
    expect(mailInternals.inferMimeTypeFromName('hello.txt')).toBe('text/plain')
    expect(mailInternals.inferMimeTypeFromName('report.')).toBeUndefined()
    expect(mailInternals.inferMimeTypeFromName('archive.unknown')).toBeUndefined()
    expect(mailInternals.createAttachmentMetadata({
      path: '/tmp/logo.png',
      disposition: 'inline',
      contentId: 'cid-logo',
    })).toEqual({
      source: 'path',
      name: 'logo.png',
      contentType: 'image/png',
      disposition: 'inline',
      contentId: 'cid-logo',
    })
    expect(mailInternals.inferAttachmentSource({
      content: 'hello',
      name: 'greeting.txt',
    })).toBe('content')
    expect(mailInternals.isAttachmentQueueSafe({
      path: '/tmp/logo.png',
    })).toBe(true)
    expect(mailInternals.isAttachmentQueueSafe({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
    })).toBe(false)
    expect(mailInternals.normalizeViewIdentifier('auth/verify-email', 'view')).toBe('auth/verify-email')
    expect(mailInternals.normalizeJsonValue({
      ok: ['yes'],
    }, 'json')).toEqual({
      ok: ['yes'],
    })
    const plans = mailInternals.createAttachmentResolutionPlans([
      {
        path: '/tmp/logo.png',
      },
      {
        content: 'hello',
        name: 'greeting.txt',
      },
    ], {
      queued: false,
    })
    expect(plans).toHaveLength(2)
    expect(plans[0]).toMatchObject({
      source: 'path',
      queuedSafe: true,
      contentType: 'image/png',
    })
    expect(mailInternals.isObject({ ok: true })).toBe(true)
    expect(mailInternals.isObject(null)).toBe(false)
    expect(() => mailInternals.normalizePriority('urgent' as never)).toThrow('Mail priority must be one of')
    expect(() => mailInternals.createAttachmentResolutionPlan({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
    }, {
      queued: true,
    })).toThrow('not queue-safe')
    expect(() => mailInternals.normalizeMailDefinition('broken' as never)).toThrow('Mail definitions must be plain objects')
  })

  it('covers remaining contract helper validation branches', async () => {
    expect(() => mailInternals.normalizeOptionalString('   ', 'Optional')).toThrow('Optional must be a non-empty string when provided')
    expect(() => mailInternals.normalizeRequiredString('   ', 'Required')).toThrow('Required must be a non-empty string')
    expect(() => mailInternals.normalizeDelayValue(-1, 'delay')).toThrow('greater than or equal to 0')
    expect(() => mailInternals.normalizeDelayValue(new Date('invalid'), 'delay')).toThrow('must be valid Date instances')
    expect(() => mailInternals.normalizeJsonValue(Symbol('bad'), 'json')).toThrow('must be JSON-serializable')
    expect(mailInternals.isValidEmail('ava example.com')).toBe(false)
    expect(() => mailInternals.normalizeHeaders('bad' as never)).toThrow('Mail headers must be a plain object')
    expect(() => mailInternals.normalizeHeaders({ Test: 1 as never })).toThrow('Mail header "Test" must be a string')
    expect(() => mailInternals.normalizeViewIdentifier('/emails/welcome', 'view')).toThrow('must be a relative mail view identifier')
    expect(() => mailInternals.normalizeAddress(1 as never, 'Mail to')).toThrow('must be an email string or an object with email')
    expect(() => mailInternals.normalizeRecipients(undefined, 'Mail to', true)).toThrow('must include at least one recipient')
    expect(mailInternals.normalizeRecipients(undefined, 'Mail cc', false)).toEqual([])
    expect(mailInternals.normalizeQueueOptions(undefined)).toBeUndefined()
    expect(mailInternals.normalizeQueueOptions(true)).toBe(true)
    expect(mailInternals.normalizeQueueOptions({
      queued: false,
      queue: 'mail',
      afterCommit: true,
    })).toEqual({
      queued: false,
      queue: 'mail',
      afterCommit: true,
    })
    expect(mailInternals.normalizeQueueOptions({
      queued: true,
      connection: 'redis',
    })).toEqual({
      queued: true,
      connection: 'redis',
    })
    expect(mailInternals.normalizeQueueOptions({
      connection: 'redis',
    } as never)).toEqual({
      connection: 'redis',
    })
    expect(mailInternals.normalizeRenderSource({
      view: 'emails/welcome',
    })).toEqual({
      view: 'emails/welcome',
    })
    expect(() => mailInternals.normalizeRenderSource('bad' as never)).toThrow('Mail render sources must be plain objects')
    expect(mailInternals.mergeMailDefinitionInputs({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    }, undefined)).toMatchObject({
      to: 'ava@example.com',
      subject: 'Welcome',
    })
    expect(mailInternals.mergeMailDefinitionInputs(defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    }), {})).toMatchObject({
      subject: 'Welcome',
    })
    expect(mailInternals.attachFromStorage('reports/invoice.pdf', {
      disk: 'public',
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      disposition: 'inline',
      contentId: 'invoice-cid',
    })).toEqual({
      storage: {
        path: 'reports/invoice.pdf',
        disk: 'public',
      },
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      disposition: 'inline',
      contentId: 'invoice-cid',
    })

    expect(() => mailInternals.normalizeAttachment({
      contentId: '<>',
      disposition: 'inline',
      content: 'hello',
      name: 'hello.txt',
    }, 0)).toThrow('Mail attachment contentId must be a non-empty string')
    expect(mailInternals.inferMimeTypeFromName('filename')).toBeUndefined()
    expect(() => mailInternals.normalizeAttachment(null as never, 0)).toThrow('must be a plain object')
    expect(() => mailInternals.resolveNormalizedAttachment({
      disposition: 'attachment',
    } as never)).toThrow('Attachments must resolve to a named attachment')
    expect(() => mailInternals.normalizeAttachment({
      name: 'broken.txt',
      path: 123 as never,
    }, 0)).toThrow('path attachments must include a path')
    expect(() => mailInternals.normalizeAttachment({
      name: 'broken.txt',
      storage: null as never,
    }, 0)).toThrow('storage attachments must include a path')
    expect(() => mailInternals.normalizeAttachment({
      content: 123 as never,
      name: 'broken.txt',
    }, 0)).toThrow('content attachments must use a string or Uint8Array')
    expect(() => mailInternals.normalizeAttachment({
      resolve: 'bad' as never,
    }, 0)).toThrow('resolve attachments must define resolve()')
    expect(() => mailInternals.normalizeAttachment({}, 0)).toThrow('must define path, storage, content, or resolve')
    expect(() => mailInternals.resolveNormalizedAttachment({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
      name: 'hello.txt',
      disposition: 'attachment',
    })).toThrow('Resolver attachments must be resolved before creating transport attachments')
    await expect(mailInternals.resolveAttachmentDefinition({
      resolve: async () => 'bad' as never,
      disposition: 'attachment',
    } as never)).rejects.toThrow('must return a plain object payload')
    await expect(mailInternals.resolveAttachmentDefinition({
      resolve: async () => ({
        name: 'preserved.txt',
        resolve: async () => ({
          content: 'nested',
          name: 'nested.txt',
        }),
      }),
      disposition: 'attachment',
    } as never)).rejects.toThrow('must resolve to a path, storage, or content attachment')
    await expect(mailInternals.resolveAttachmentDefinition({
      name: 'outer.txt',
      disposition: 'attachment',
      resolve: async () => ({
        content: 'hello',
      }),
    } as never)).resolves.toEqual({
      name: 'outer.txt',
      disposition: 'attachment',
      content: 'hello',
      contentType: 'text/plain',
    })
    await expect(mailInternals.resolveAttachmentDefinition({
      name: 'outer.txt',
      disposition: 'inline',
      contentId: 'cid-outer',
      contentType: 'text/plain',
      resolve: async () => ({
        content: 'hello',
      }),
    } as never)).resolves.toEqual({
      name: 'outer.txt',
      disposition: 'inline',
      contentId: 'cid-outer',
      content: 'hello',
      contentType: 'text/plain',
    })
    await expect(mailInternals.resolveAttachmentDefinition({
      resolve: async () => ({
        content: 'hello',
        name: 'resolved.txt',
      }),
    } as never)).resolves.toEqual({
      name: 'resolved.txt',
      disposition: 'attachment',
      content: 'hello',
      contentType: 'text/plain',
    })
    await expect(mailInternals.resolveAttachmentDefinition({
      resolve: async () => ({
        content: 'hello',
        name: 'resolved.txt',
      }),
      disposition: 'attachment',
      contentType: 'text/plain',
    } as never)).resolves.toEqual({
      name: 'resolved.txt',
      disposition: 'attachment',
      content: 'hello',
      contentType: 'text/plain',
    })
  })
})
