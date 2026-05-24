import { describe, expect, it } from 'vitest'
import {
  attachFromStorage,
  createAttachmentMetadata,
  createAttachmentResolutionPlan,
  createAttachmentResolutionPlans,
  defineMail,
  inferMimeTypeFromName,
  isAttachmentQueueSafe,
  isMailDefinition,
  mergeMailDefinitionInputs,
  normalizeMailDefinition,
  resolveAttachmentDefinition,
  resolveNormalizedAttachment,
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

    const merged = mergeMailDefinitionInputs(base, {
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
    expect(inferMimeTypeFromName('logo.png')).toBe('image/png')
    expect(inferMimeTypeFromName('hello.txt')).toBe('text/plain')
    expect(inferMimeTypeFromName('report.')).toBeUndefined()
    expect(inferMimeTypeFromName('archive.unknown')).toBeUndefined()
    expect(createAttachmentMetadata({
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
    expect(isAttachmentQueueSafe({
      path: '/tmp/logo.png',
    })).toBe(true)
    expect(isAttachmentQueueSafe({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
    })).toBe(false)
    const plans = createAttachmentResolutionPlans([
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
    expect(() => createAttachmentResolutionPlan({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
    }, {
      queued: true,
    })).toThrow('not queue-safe')
    expect(() => normalizeMailDefinition('broken' as never)).toThrow('Mail definitions must be plain objects')
  })

  it('covers remaining contract helper validation branches', async () => {
    expect(() => defineMail({
      to: 'ava@example.com',
      subject: 'Stats',
      text: 'Body',
      metadata: {
        score: Number.NaN,
      },
    })).toThrow('must be JSON-serializable')
    expect(mergeMailDefinitionInputs({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    }, undefined)).toMatchObject({
      to: 'ava@example.com',
      subject: 'Welcome',
    })
    expect(mergeMailDefinitionInputs(defineMail({
      to: 'ava@example.com',
      subject: 'Welcome',
      markdown: '# Welcome',
    }), {})).toMatchObject({
      subject: 'Welcome',
    })
    expect(attachFromStorage('reports/invoice.pdf', {
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

    expect(inferMimeTypeFromName('filename')).toBeUndefined()
    expect(() => resolveNormalizedAttachment({
      disposition: 'attachment',
    } as never)).toThrow('Attachments must resolve to a named attachment')
    expect(() => resolveNormalizedAttachment({
      resolve: async () => ({
        content: 'hello',
        name: 'hello.txt',
      }),
      name: 'hello.txt',
      disposition: 'attachment',
    })).toThrow('Resolver attachments must be resolved before creating transport attachments')
    await expect(resolveAttachmentDefinition({
      resolve: async () => 'bad' as never,
      disposition: 'attachment',
    } as never)).rejects.toThrow('must return a plain object payload')
    await expect(resolveAttachmentDefinition({
      resolve: async () => ({
        name: 'preserved.txt',
        resolve: async () => ({
          content: 'nested',
          name: 'nested.txt',
        }),
      }),
      disposition: 'attachment',
    } as never)).rejects.toThrow('must resolve to a path, storage, or content attachment')
    await expect(resolveAttachmentDefinition({
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
    await expect(resolveAttachmentDefinition({
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
    await expect(resolveAttachmentDefinition({
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
    await expect(resolveAttachmentDefinition({
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
