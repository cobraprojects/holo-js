import {
  BUILT_IN_MAIL_COMPONENTS,
  isAbsoluteHttpUrl,
  resolveMailComponentBehavior,
  type MailComponentSource,
} from './components'
import type { MailJsonObject, MailJsonValue } from './contracts-types'
import { MailError } from './errors'
import { renderMarkdown, renderMarkdownInline } from './markdown'

export type MailTemplateValueNode
  = { readonly type: 'text', readonly value: string }
  | { readonly type: 'output', readonly path: readonly string[], readonly escaped: boolean }

export interface MailTemplateComponentNode {
  readonly type: 'component'
  readonly name: string
  readonly attributes: Readonly<Record<string, readonly MailTemplateValueNode[]>>
  readonly children: readonly MailTemplateNode[]
}

export type MailTemplateNode = MailTemplateValueNode | MailTemplateComponentNode

export type MailTemplateFormat = 'html' | 'text'

export interface CompiledMailTemplate {
  readonly nodes: readonly MailTemplateNode[]
  readonly data: MailTemplateDataObjectShape
}

export type CompiledMailComponent = Readonly<Record<MailTemplateFormat, readonly MailTemplateNode[]>>

export interface CompiledMailRegistry {
  readonly templates: Readonly<Record<string, CompiledMailTemplate>>
  readonly components: Readonly<Record<string, CompiledMailComponent>>
}

export interface MailRegistrySources {
  readonly templates: Readonly<Record<string, string>>
}

export type MailTemplateDataShape
  = { readonly kind: 'value' }
  | MailTemplateDataObjectShape

export interface MailTemplateDataObjectShape {
  readonly kind: 'object'
  readonly properties: Readonly<Record<string, MailTemplateDataShape>>
}

interface Delimiter {
  readonly open: string
  readonly close: string
  readonly escaped: boolean
}

type TemplateMarker
  = { readonly kind: 'output', readonly delimiter: Delimiter }
  | { readonly kind: 'componentOpen' }
  | { readonly kind: 'componentClose' }

interface OpenComponent {
  readonly name: string
  readonly line: number
  readonly attributes: Readonly<Record<string, readonly MailTemplateValueNode[]>>
  readonly children: MailTemplateNode[]
}

interface CompileContext {
  readonly template: string
  readonly source: string
  readonly components: ReadonlySet<string>
}

interface RenderContext {
  readonly registry: CompiledMailRegistry
  readonly template: string
  readonly format: MailTemplateFormat
}

const DELIMITERS: readonly Delimiter[] = [
  { open: '{!!', close: '!!}', escaped: false },
  { open: '{{', close: '}}', escaped: true },
]
const TEMPLATE_MARKERS: readonly { readonly open: string, readonly marker: TemplateMarker }[] = [
  ...DELIMITERS.map(delimiter => ({ open: delimiter.open, marker: { kind: 'output', delimiter } as const })),
  { open: '<mail::', marker: { kind: 'componentOpen' } },
  { open: '</mail::', marker: { kind: 'componentClose' } },
]
const COMPONENT_OPEN_TAG_PATTERN = /<mail::([a-z][\w-]*)((?:\s+[A-Za-z_][\w-]*="[^"]*")*)\s*>/y
const COMPONENT_CLOSE_TAG_PATTERN = /<\/mail::([a-z][\w-]*)\s*>/y
const COMPONENT_ATTRIBUTE_PATTERN = /([A-Za-z_][\w-]*)="([^"]*)"/g
const PATH_SEGMENT_PATTERN = /^[A-Za-z_]\w*$/
const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#039;',
}

export class MailTemplateSyntaxError extends MailError {
  readonly template: string
  readonly line: number

  constructor(template: string, line: number, reason: string) {
    super(`[@holo-js/mail] Mail template "${template}" line ${line}: ${reason}`, 'MAIL_TEMPLATE_SYNTAX')
    this.name = 'MailTemplateSyntaxError'
    this.template = template
    this.line = line
  }
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function findNextDelimiter(source: string, from: number): { readonly index: number, readonly delimiter: Delimiter } | undefined {
  return DELIMITERS
    .map(delimiter => ({ index: source.indexOf(delimiter.open, from), delimiter }))
    .filter(match => match.index !== -1)
    .sort((left, right) => left.index - right.index)[0]
}

function parsePath(template: string, line: number, expression: string): readonly string[] {
  const segments = expression.trim().split('.')
  if (!segments.every(segment => PATH_SEGMENT_PATTERN.test(segment))) {
    throw new MailTemplateSyntaxError(template, line, `"${expression.trim()}" is not a data path. Use names separated by dots, such as "order.id".`)
  }

  return Object.freeze(segments)
}

function readOutput(
  template: string,
  source: string,
  index: number,
  delimiter: Delimiter,
  line: number,
): { readonly node: MailTemplateValueNode, readonly end: number } {
  const expressionStart = index + delimiter.open.length
  const closeIndex = source.indexOf(delimiter.close, expressionStart)
  if (closeIndex === -1) {
    throw new MailTemplateSyntaxError(template, line, `"${delimiter.open}" is not closed with "${delimiter.close}".`)
  }

  return {
    node: Object.freeze({
      type: 'output',
      path: parsePath(template, line, source.slice(expressionStart, closeIndex)),
      escaped: delimiter.escaped,
    }),
    end: closeIndex + delimiter.close.length,
  }
}

function compileValueNodes(template: string, line: number, source: string): readonly MailTemplateValueNode[] {
  const nodes: MailTemplateValueNode[] = []
  let cursor = 0
  for (let match = findNextDelimiter(source, cursor); match; match = findNextDelimiter(source, cursor)) {
    if (match.index > cursor) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor, match.index) }))
    const output = readOutput(template, source, match.index, match.delimiter, line)
    nodes.push(output.node)
    cursor = output.end
  }

  if (cursor < source.length) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor) }))
  return Object.freeze(nodes)
}

function findNextMarker(source: string, from: number): { readonly index: number, readonly marker: TemplateMarker } | undefined {
  return TEMPLATE_MARKERS
    .map(({ open, marker }) => ({ index: source.indexOf(open, from), marker }))
    .filter(match => match.index !== -1)
    .sort((left, right) => left.index - right.index)[0]
}

function matchTag(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(source)
}

function malformedTagError(context: CompileContext, line: number): MailTemplateSyntaxError {
  return new MailTemplateSyntaxError(context.template, line, 'Malformed Mail component tag. Write it as <mail::name attribute="value">.')
}

function compileAttributes(
  context: CompileContext,
  line: number,
  source: string,
): Readonly<Record<string, readonly MailTemplateValueNode[]>> {
  const attributes: Record<string, readonly MailTemplateValueNode[]> = {}
  for (const [, name = '', value = ''] of source.matchAll(COMPONENT_ATTRIBUTE_PATTERN)) {
    if (Object.hasOwn(attributes, name)) {
      throw new MailTemplateSyntaxError(context.template, line, `Mail component attribute "${name}" is set more than once.`)
    }
    attributes[name] = compileValueNodes(context.template, line, value)
  }

  return Object.freeze(attributes)
}

function openComponent(context: CompileContext, index: number, line: number): { readonly component: OpenComponent, readonly end: number } {
  const tag = matchTag(COMPONENT_OPEN_TAG_PATTERN, context.source, index)
  if (!tag) throw malformedTagError(context, line)
  const [match, name = '', attributes = ''] = tag
  if (!context.components.has(name)) {
    throw new MailTemplateSyntaxError(context.template, line, `<mail::${name}> is not a Mail component.`)
  }

  return {
    component: { name, line, attributes: compileAttributes(context, line, attributes), children: [] },
    end: index + match.length,
  }
}

function closeComponent(context: CompileContext, stack: OpenComponent[], index: number, line: number): { readonly node: MailTemplateComponentNode, readonly end: number } {
  const tag = matchTag(COMPONENT_CLOSE_TAG_PATTERN, context.source, index)
  if (!tag) throw malformedTagError(context, line)
  const [match, name = ''] = tag
  const component = stack.pop()
  if (component?.name !== name) {
    throw new MailTemplateSyntaxError(context.template, line, `</mail::${name}> does not close an open <mail::${name}>.`)
  }

  return {
    node: Object.freeze({
      type: 'component',
      name,
      attributes: component.attributes,
      children: Object.freeze(component.children),
    }),
    end: index + match.length,
  }
}

function compileNodes(template: string, source: string, components: ReadonlySet<string>): readonly MailTemplateNode[] {
  const context: CompileContext = { template, source, components }
  const root: MailTemplateNode[] = []
  const stack: OpenComponent[] = []
  const currentNodes = (): MailTemplateNode[] => stack.at(-1)?.children ?? root
  let cursor = 0
  for (let match = findNextMarker(source, cursor); match; match = findNextMarker(source, cursor)) {
    const { index, marker } = match
    const line = lineAt(source, index)
    if (index > cursor) currentNodes().push(Object.freeze({ type: 'text', value: source.slice(cursor, index) }))
    if (marker.kind === 'componentOpen') {
      const opened = openComponent(context, index, line)
      stack.push(opened.component)
      cursor = opened.end
    } else if (marker.kind === 'componentClose') {
      const closed = closeComponent(context, stack, index, line)
      currentNodes().push(closed.node)
      cursor = closed.end
    } else {
      const output = readOutput(template, source, index, marker.delimiter, line)
      currentNodes().push(output.node)
      cursor = output.end
    }
  }

  const unclosed = stack.at(-1)
  if (unclosed) {
    throw new MailTemplateSyntaxError(template, unclosed.line, `<mail::${unclosed.name}> is not closed with </mail::${unclosed.name}>.`)
  }

  if (cursor < source.length) root.push(Object.freeze({ type: 'text', value: source.slice(cursor) }))
  return Object.freeze(root)
}

function compileMailComponent(
  name: string,
  source: MailComponentSource,
  components: ReadonlySet<string>,
): CompiledMailComponent {
  return Object.freeze({
    html: compileNodes(`components/${name}`, source.html, components),
    text: compileNodes(`components/${name}`, source.text, components),
  })
}

export function compileMailRegistry(sources: MailRegistrySources): CompiledMailRegistry {
  const componentSources = BUILT_IN_MAIL_COMPONENTS
  const componentNames = new Set(Object.keys(componentSources))
  return Object.freeze({
    templates: Object.freeze(Object.fromEntries(Object.entries(sources.templates).map(([name, source]) => {
      const nodes = compileNodes(name, source, componentNames)
      return [name, Object.freeze({ nodes, data: describeTemplateData(name, nodes) })]
    }))),
    components: Object.freeze(Object.fromEntries(Object.entries(componentSources).map(([name, source]) => {
      return [name, compileMailComponent(name, source, componentNames)]
    }))),
  })
}

function addPathToShape(
  template: string,
  properties: Record<string, MailTemplateDataShape>,
  path: readonly string[],
): void {
  const [segment, ...rest] = path
  if (!segment) return
  const existing = properties[segment]
  if (rest.length === 0) {
    if (existing?.kind === 'object') throw conflictingPathError(template, path)
    properties[segment] = { kind: 'value' }
    return
  }

  if (existing?.kind === 'value') throw conflictingPathError(template, path)
  const nested = existing?.kind === 'object' ? { ...existing.properties } : {}
  addPathToShape(template, nested, rest)
  properties[segment] = { kind: 'object', properties: nested }
}

function conflictingPathError(template: string, path: readonly string[]): MailError {
  return new MailError(
    `[@holo-js/mail] Mail template "${template}" uses "${path.join('.')}" both as a value and as an object.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

function collectOutputPaths(nodes: readonly MailTemplateNode[]): readonly (readonly string[])[] {
  return nodes.flatMap((node) => {
    if (node.type === 'text') return []
    if (node.type === 'output') return [node.path]
    return [...Object.values(node.attributes).flatMap(collectOutputPaths), ...collectOutputPaths(node.children)]
  })
}

function describeTemplateData(name: string, nodes: readonly MailTemplateNode[]): MailTemplateDataObjectShape {
  const properties: Record<string, MailTemplateDataShape> = {}
  for (const path of collectOutputPaths(nodes)) addPathToShape(name, properties, path)
  return { kind: 'object', properties }
}

function isJsonObject(value: MailJsonValue | undefined): value is MailJsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function lookupDataPath(data: MailJsonObject, path: readonly string[]): MailJsonValue | undefined {
  let current: MailJsonValue | undefined = data
  for (const segment of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }

  return current
}

function escapeTemplateValue(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] ?? character)
}

function renderOutput(name: string, data: MailJsonObject, path: readonly string[], escaped: boolean): string {
  const value = lookupDataPath(data, path)
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new MailError(
      `[@holo-js/mail] Mail template "${name}" requires a string or number for "${path.join('.')}".`,
      'MAIL_TEMPLATE_DATA_INVALID',
    )
  }

  return escaped ? escapeTemplateValue(String(value)) : String(value)
}

function renderAttributeValue(template: string, data: MailJsonObject, nodes: readonly MailTemplateValueNode[]): string {
  return nodes.map(node => node.type === 'text' ? node.value : renderOutput(template, data, node.path, false)).join('')
}

function resolveComponent(context: RenderContext, name: string): CompiledMailComponent {
  const component = Object.hasOwn(context.registry.components, name) ? context.registry.components[name] : undefined
  if (!component) {
    throw new MailError(`[@holo-js/mail] Mail component "${name}" is not registered. Run "holo prepare".`, 'MAIL_COMPONENT_NOT_FOUND')
  }

  return component
}

function resolveComponentAttributes(
  context: RenderContext,
  node: MailTemplateComponentNode,
  data: MailJsonObject,
): Readonly<Record<string, string>> {
  const behavior = resolveMailComponentBehavior(node.name)
  const attributes: Readonly<Record<string, string>> = {
    ...behavior.defaults,
    ...Object.fromEntries(Object.entries(node.attributes).map(([name, value]) => [name, renderAttributeValue(context.template, data, value)])),
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

function renderSlot(context: RenderContext, node: MailTemplateComponentNode, data: MailJsonObject): string {
  const source = renderNodes(context, node.children, data).trim()
  if (context.format === 'text') return source
  return resolveMailComponentBehavior(node.name).slot === 'inline' ? renderMarkdownInline(source) : renderMarkdown(source)
}

function renderComponent(context: RenderContext, node: MailTemplateComponentNode, data: MailJsonObject): string {
  const component = resolveComponent(context, node.name)
  const componentData: MailJsonObject = {
    ...resolveComponentAttributes(context, node, data),
    slot: renderSlot(context, node, data),
  }

  return renderNodes({ ...context, template: `components/${node.name}` }, component[context.format], componentData)
}

function renderNodes(context: RenderContext, nodes: readonly MailTemplateNode[], data: MailJsonObject): string {
  return nodes.map((node) => {
    if (node.type === 'text') return node.value
    if (node.type === 'output') return renderOutput(context.template, data, node.path, node.escaped)
    return renderComponent(context, node, data)
  }).join('')
}

export function renderMailTemplate(
  registry: CompiledMailRegistry,
  name: string,
  data: MailJsonObject,
  format: MailTemplateFormat,
): string {
  const template = Object.hasOwn(registry.templates, name) ? registry.templates[name] : undefined
  if (!template) {
    throw new MailError(
      `[@holo-js/mail] Mail template "${name}" is not registered. Run "holo prepare" after adding it under server/mail/templates.`,
      'MAIL_TEMPLATE_NOT_FOUND',
    )
  }

  return renderNodes({ registry, template: name, format }, template.nodes, data)
}
