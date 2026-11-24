import { decodeHTML, escapeUTF8 } from 'entities'
import juice from 'juice'
import type { MailAppIdentity, MailJsonObject } from './contracts-types'
import { renderMarkdown, renderMarkdownText } from './markdown'
import { renderMailLayout, renderMailTemplate, resolveMailTheme, type CompiledMailRegistry } from './templates'

export interface MailTemplateSelection {
  readonly name: string
  readonly data: MailJsonObject
}

export interface MarkdownMailContext {
  readonly registry: CompiledMailRegistry
  readonly app: MailAppIdentity
  readonly subject: string
  readonly theme: string
}

const THEME_INLINING_OPTIONS = Object.freeze({
  applyAttributesTableElements: false,
  applyHeightAttributes: false,
  applyWidthAttributes: false,
})

export function renderMarkdownMail(
  template: MailTemplateSelection,
  context: MarkdownMailContext,
): { readonly html: string, readonly text: string } {
  const { registry } = context
  const themeCss = resolveMailTheme(registry, context.theme)
  const layoutData = {
    app: { name: context.app.name, url: context.app.url },
    subject: context.subject,
    year: new Date().getFullYear(),
  }
  const htmlBody = renderMarkdown(renderMailTemplate(registry, template.name, template.data, 'html'))
  const textBody = renderMarkdownText(renderMailTemplate(registry, template.name, template.data, 'text'))
  const html = renderMailLayout(registry, 'html', { ...layoutData, body: htmlBody })
  const text = renderMailLayout(registry, 'text', { ...layoutData, body: escapeUTF8(textBody) })

  return Object.freeze({
    html: juice.inlineContent(html, themeCss, THEME_INLINING_OPTIONS),
    text: decodeHTML(text).trim(),
  })
}
