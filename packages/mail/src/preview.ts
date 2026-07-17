import type { MailPreviewFormat, MailPreviewResult } from './contracts'
import { MailPreviewFormatUnavailableError } from './errors'

export function escapePreviewHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

export function formatPreviewAddress(address: { readonly email: string, readonly name?: string }): string {
  return address.name
    ? `${escapePreviewHtml(address.name)} &lt;${escapePreviewHtml(address.email)}&gt;`
    : escapePreviewHtml(address.email)
}

export function createMailPreviewHtml(preview: MailPreviewResult): string {
  const header = [
    `<h1>${escapePreviewHtml(preview.subject)}</h1>`,
    `<p><strong>From:</strong> ${formatPreviewAddress(preview.from)}</p>`,
    `<p><strong>Reply-To:</strong> ${formatPreviewAddress(preview.replyTo)}</p>`,
    `<p><strong>To:</strong> ${preview.to.map(formatPreviewAddress).join(', ')}</p>`,
    preview.cc.length > 0 ? `<p><strong>Cc:</strong> ${preview.cc.map(formatPreviewAddress).join(', ')}</p>` : '',
    preview.bcc.length > 0 ? `<p><strong>Bcc:</strong> ${preview.bcc.map(formatPreviewAddress).join(', ')}</p>` : '',
  ].filter(Boolean).join('')

  const body = preview.html
    ? `<pre>${escapePreviewHtml(preview.html)}</pre>`
    : preview.text
      ? `<pre>${escapePreviewHtml(preview.text)}</pre>`
      : '<p>No rendered content is available.</p>'

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapePreviewHtml(preview.subject)}</title></head><body>${header}${body}</body></html>`
}

export function createMailPreviewResponse(
  preview: MailPreviewResult,
  format: MailPreviewFormat,
): Response {
  if (format === 'json') {
    return new Response(JSON.stringify(preview, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }

  if (format === 'text') {
    if (typeof preview.text !== 'string') throw new MailPreviewFormatUnavailableError(format)

    return new Response(preview.text, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(createMailPreviewHtml(preview), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}
