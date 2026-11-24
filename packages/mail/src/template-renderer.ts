import { decodeHTML } from 'entities'
import { isAbsoluteHttpUrl, resolveMailComponentBehavior } from './components'
import type { MailJsonObject, MailJsonValue } from './contracts-types'
import { DEFAULT_MAIL_SOURCES } from './defaults'
import { MailError } from './errors'
import { escapeMarkdown, renderMarkdown, renderMarkdownInline } from './markdown'
import { findOwnEntry } from './own-entry'
import {
  BUILT_IN_COMPILED_MAIL_COMPONENTS,
  BUILT_IN_COMPILED_MAIL_LAYOUTS,
  BUILT_IN_COMPILED_MAIL_TEMPLATES,
  MAIL_LAYOUT_FILE_NAMES,
  type CompiledMailComponent,
  type CompiledMailRegistry,
} from './template-compiler'
import {
  findInnermostLoop,
  type MailTemplateComponentNode,
  type MailTemplateForeachNode,
  type MailTemplateFormat,
  type MailTemplateNode,
  type MailTemplateValueNode,
} from './template-syntax'

interface LoopValue {
  readonly name: string
  readonly value: MailJsonValue
}

interface RenderContext {
  readonly registry: CompiledMailRegistry
  readonly template: string
  readonly format: MailTemplateFormat
  readonly data: MailJsonObject
  readonly encoding: TemplateValueEncoding
  readonly htmlValues: ReadonlySet<string>
  readonly markdownValues: ReadonlySet<string>
  readonly loops: readonly LoopValue[]
}

export interface TemplateValueEncoding {
  readonly pattern: RegExp
  readonly entities: Readonly<Record<string, string>>
}

interface RenderedAttribute {
  readonly value: string
  readonly html: boolean
}

const NO_VALUES: ReadonlySet<string> = new Set()

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#039;',
}

const HTML_ENCODING: TemplateValueEncoding = Object.freeze({
  pattern: /[&<>"']/g,
  entities: HTML_ESCAPES,
})

const SECURED_ENCODING: TemplateValueEncoding = Object.freeze({
  pattern: /[&<>"'[\]\\]/g,
  entities: Object.freeze({ ...HTML_ESCAPES, '[': '&#91;', ']': '&#93;', '\\': '&#92;' }),
})

function isJsonObject(value: MailJsonValue | undefined): value is MailJsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function lookupDataPath(start: MailJsonValue, path: readonly string[]): MailJsonValue | undefined {
  let current: MailJsonValue | undefined = start
  for (const segment of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }

  return current
}

function resolveDataPath(context: RenderContext, path: readonly string[]): MailJsonValue | undefined {
  const [first, ...rest] = path
  const loop = findInnermostLoop(context.loops, first)
  return loop ? lookupDataPath(loop.value, rest) : lookupDataPath(context.data, path)
}

function invalidDataError(context: RenderContext, expected: string, path: readonly string[]): MailError {
  return new MailError(
    `[@holo-js/mail] Mail template "${context.template}" requires ${expected} for "${path.join('.')}".`,
    'MAIL_TEMPLATE_DATA_INVALID',
  )
}

function isTruthy(value: MailJsonValue | undefined): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isJsonObject(value)) return Object.keys(value).length > 0
  return !!value && value !== '0'
}

function escapeTemplateValue(value: string, encoding: TemplateValueEncoding): string {
  return value.replace(encoding.pattern, character => encoding.entities[character] ?? character)
}

function isNamedValue(context: RenderContext, names: ReadonlySet<string>, path: readonly string[]): boolean {
  const [name, ...rest] = path
  return rest.length === 0 && name !== undefined && names.has(name) && !findInnermostLoop(context.loops, name)
}

function resolveOutputValue(context: RenderContext, path: readonly string[]): string {
  const value = resolveDataPath(context, path)
  if (typeof value !== 'string' && typeof value !== 'number') throw invalidDataError(context, 'a string or number', path)
  return String(value)
}

function renderEscapedOutput(context: RenderContext, path: readonly string[], escaped: boolean): string {
  const value = resolveOutputValue(context, path)
  return escaped && !isNamedValue(context, context.htmlValues, path) ? escapeTemplateValue(value, context.encoding) : value
}

function renderOutput(context: RenderContext, path: readonly string[], escaped: boolean): string {
  if (!isNamedValue(context, context.markdownValues, path)) return renderEscapedOutput(context, path, escaped)
  return escapeMarkdown(resolveOutputValue(context, path))
}

function renderAttribute(context: RenderContext, nodes: readonly MailTemplateValueNode[]): RenderedAttribute {
  const html = nodes.some(node => node.type === 'output')
  const value = nodes.map((node) => {
    if (node.type === 'output') return renderEscapedOutput(context, node.path, node.escaped)
    return html ? escapeTemplateValue(node.value, HTML_ENCODING) : node.value
  }).join('')

  return { value, html }
}

function resolveComponent(context: RenderContext, name: string): CompiledMailComponent {
  const component = findOwnEntry(context.registry.components, name) ?? findOwnEntry(BUILT_IN_COMPILED_MAIL_COMPONENTS, name)
  if (!component) {
    throw new MailError(`[@holo-js/mail] Mail component "${name}" is not registered. Run "holo prepare".`, 'MAIL_COMPONENT_NOT_FOUND')
  }

  return component
}

function attributeText(attribute: RenderedAttribute | undefined): string {
  if (!attribute) return ''
  return attribute.html ? decodeHTML(attribute.value) : attribute.value
}

function resolveComponentAttributes(context: RenderContext, node: MailTemplateComponentNode): ReadonlyMap<string, RenderedAttribute> {
  const behavior = resolveMailComponentBehavior(node.name)
  const attributes = new Map<string, RenderedAttribute>([
    ...Object.entries(behavior.defaults).map(([name, value]) => [name, { value, html: false }] as const),
    ...Object.entries(node.attributes).map(([name, value]) => [name, renderAttribute(context, value)] as const),
  ])
  const invalidUrlAttribute = behavior.urlAttributes.find(name => !isAbsoluteHttpUrl(attributeText(attributes.get(name))))
  if (invalidUrlAttribute) {
    throw new MailError(
      `[@holo-js/mail] Mail component "${node.name}" in Mail template "${context.template}" requires an absolute http or https "${invalidUrlAttribute}".`,
      'MAIL_COMPONENT_INVALID',
    )
  }

  return attributes
}

function renderSlot(context: RenderContext, node: MailTemplateComponentNode): string {
  const source = renderNodes(context, node.children).trim()
  if (context.format === 'text') return source
  return resolveMailComponentBehavior(node.name).slot === 'inline' ? renderMarkdownInline(source) : renderMarkdown(source)
}

function renderComponent(context: RenderContext, node: MailTemplateComponentNode): string {
  const component = resolveComponent(context, node.name)
  const attributes = [...resolveComponentAttributes(context, node)]
  const html = context.format === 'html'
  const data: MailJsonObject = {
    ...Object.fromEntries(attributes.map(([name, attribute]) => [name, html ? attribute.value : attributeText(attribute)])),
    slot: renderSlot(context, node),
  }
  const htmlValues = new Set(attributes.filter(([, attribute]) => html && attribute.html).map(([name]) => name)).add('slot')
  const markdownValues = html ? NO_VALUES : new Set(attributes.map(([name]) => name))

  return renderNodes(
    { ...context, template: `components/${node.name}`, data, htmlValues, markdownValues, loops: [] },
    component[context.format],
  )
}

function renderLoop(context: RenderContext, node: MailTemplateForeachNode): string {
  const items = resolveDataPath(context, node.path)
  if (!Array.isArray(items)) throw invalidDataError(context, 'a list', node.path)
  return items.map((value: MailJsonValue) => renderNodes(
    { ...context, loops: [...context.loops, { name: node.item, value }] },
    node.body,
  )).join('')
}

function renderNode(context: RenderContext, node: MailTemplateNode): string {
  switch (node.type) {
    case 'text': return node.value
    case 'output': return renderOutput(context, node.path, node.escaped)
    case 'component': return renderComponent(context, node)
    case 'if': return renderNodes(context, isTruthy(resolveDataPath(context, node.path)) ? node.then : node.otherwise)
    case 'foreach': return renderLoop(context, node)
    case 'include': return renderTemplate({ ...context, template: node.template })
  }
}

function renderNodes(context: RenderContext, nodes: readonly MailTemplateNode[]): string {
  return nodes.map(node => renderNode(context, node)).join('')
}

function renderTemplate(context: RenderContext): string {
  const template = findOwnEntry(context.registry.templates, context.template)
    ?? findOwnEntry(BUILT_IN_COMPILED_MAIL_TEMPLATES, context.template)
  if (!template) {
    throw new MailError(
      `[@holo-js/mail] Mail template "${context.template}" is not registered. Run "holo prepare" after adding it under server/mail/templates.`,
      'MAIL_TEMPLATE_NOT_FOUND',
    )
  }

  return renderNodes(context, template.nodes)
}

function createRenderContext(
  registry: CompiledMailRegistry,
  template: string,
  format: MailTemplateFormat,
  data: MailJsonObject,
  encoding: TemplateValueEncoding,
): RenderContext {
  return { registry, template, format, data, encoding, htmlValues: NO_VALUES, markdownValues: NO_VALUES, loops: [] }
}

export function resolveTemplateValueEncoding(securedEncoding: boolean): TemplateValueEncoding {
  return securedEncoding ? SECURED_ENCODING : HTML_ENCODING
}

export function renderMailTemplate(
  registry: CompiledMailRegistry,
  name: string,
  data: MailJsonObject,
  format: MailTemplateFormat,
  encoding: TemplateValueEncoding,
): string {
  return renderTemplate(createRenderContext(registry, name, format, data, encoding))
}

export function renderMailLayout(registry: CompiledMailRegistry, format: MailTemplateFormat, data: MailJsonObject): string {
  const layout = registry.layouts[format] ?? BUILT_IN_COMPILED_MAIL_LAYOUTS[format]
  return renderNodes(createRenderContext(registry, MAIL_LAYOUT_FILE_NAMES[format], format, data, HTML_ENCODING), layout.nodes)
}

export function resolveMailTheme(registry: CompiledMailRegistry, name: string): string {
  const theme = findOwnEntry(registry.themes, name) ?? findOwnEntry(DEFAULT_MAIL_SOURCES.themes, name)
  if (theme !== undefined) return theme
  throw new MailError(
    `[@holo-js/mail] Mail theme "${name}" is not registered. Run "holo prepare" after adding it under server/mail/themes.`,
    'MAIL_THEME_NOT_FOUND',
  )
}
