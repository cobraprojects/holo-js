import { isAbsoluteHttpUrl, resolveMailComponentBehavior } from './components'
import type { MailJsonObject, MailJsonValue } from './contracts-types'
import { DEFAULT_MAIL_SOURCES } from './defaults'
import { MailError } from './errors'
import { renderMarkdown, renderMarkdownInline } from './markdown'
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
  readonly loops: readonly LoopValue[]
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#039;',
}

function findCompiledEntry<TEntry>(entries: Readonly<Record<string, TEntry>>, name: string): TEntry | undefined {
  return Object.hasOwn(entries, name) ? entries[name] : undefined
}

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

function escapeTemplateValue(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character)
}

function renderOutput(context: RenderContext, path: readonly string[], escaped: boolean): string {
  const value = resolveDataPath(context, path)
  if (typeof value !== 'string' && typeof value !== 'number') throw invalidDataError(context, 'a string or number', path)
  return escaped ? escapeTemplateValue(String(value)) : String(value)
}

function renderAttributeValue(context: RenderContext, nodes: readonly MailTemplateValueNode[]): string {
  return nodes.map(node => node.type === 'text' ? node.value : renderOutput(context, node.path, false)).join('')
}

function resolveComponent(context: RenderContext, name: string): CompiledMailComponent {
  const component = findCompiledEntry(context.registry.components, name) ?? findCompiledEntry(BUILT_IN_COMPILED_MAIL_COMPONENTS, name)
  if (!component) {
    throw new MailError(`[@holo-js/mail] Mail component "${name}" is not registered. Run "holo prepare".`, 'MAIL_COMPONENT_NOT_FOUND')
  }

  return component
}

function resolveComponentAttributes(context: RenderContext, node: MailTemplateComponentNode): Readonly<Record<string, string>> {
  const behavior = resolveMailComponentBehavior(node.name)
  const attributes: Readonly<Record<string, string>> = {
    ...behavior.defaults,
    ...Object.fromEntries(Object.entries(node.attributes).map(([name, value]) => [name, renderAttributeValue(context, value)])),
  }
  const invalidUrlAttribute = behavior.urlAttributes.find(name => !isAbsoluteHttpUrl(attributes[name] ?? ''))
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
  const data: MailJsonObject = {
    ...resolveComponentAttributes(context, node),
    slot: renderSlot(context, node),
  }

  return renderNodes({ ...context, template: `components/${node.name}`, data, loops: [] }, component[context.format])
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
    case 'if': return renderNodes(context, resolveDataPath(context, node.path) ? node.then : node.otherwise)
    case 'foreach': return renderLoop(context, node)
    case 'include': return renderMailTemplate(context.registry, node.template, context.data, context.format)
  }
}

function renderNodes(context: RenderContext, nodes: readonly MailTemplateNode[]): string {
  return nodes.map(node => renderNode(context, node)).join('')
}

export function renderMailTemplate(
  registry: CompiledMailRegistry,
  name: string,
  data: MailJsonObject,
  format: MailTemplateFormat,
): string {
  const template = findCompiledEntry(registry.templates, name) ?? findCompiledEntry(BUILT_IN_COMPILED_MAIL_TEMPLATES, name)
  if (!template) {
    throw new MailError(
      `[@holo-js/mail] Mail template "${name}" is not registered. Run "holo prepare" after adding it under server/mail/templates.`,
      'MAIL_TEMPLATE_NOT_FOUND',
    )
  }

  return renderNodes({ registry, template: name, format, data, loops: [] }, template.nodes)
}

export function renderMailLayout(registry: CompiledMailRegistry, format: MailTemplateFormat, data: MailJsonObject): string {
  const layout = registry.layouts[format] ?? BUILT_IN_COMPILED_MAIL_LAYOUTS[format]
  return renderNodes({ registry, template: MAIL_LAYOUT_FILE_NAMES[format], format, data, loops: [] }, layout.nodes)
}

export function resolveMailTheme(registry: CompiledMailRegistry, name: string): string {
  const theme = findCompiledEntry(registry.themes, name) ?? findCompiledEntry(DEFAULT_MAIL_SOURCES.themes, name)
  if (theme !== undefined) return theme
  throw new MailError(
    `[@holo-js/mail] Mail theme "${name}" is not registered. Run "holo prepare" after adding it under server/mail/themes.`,
    'MAIL_THEME_NOT_FOUND',
  )
}
