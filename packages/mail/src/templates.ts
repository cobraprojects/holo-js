import {
  BUILT_IN_MAIL_COMPONENTS,
  isAbsoluteHttpUrl,
  resolveMailComponentBehavior,
  type MailComponentSource,
} from './components'
import type { MailJsonObject, MailJsonValue } from './contracts-types'
import { DEFAULT_MAIL_LAYOUT_HTML, DEFAULT_MAIL_LAYOUT_TEXT, DEFAULT_MAIL_THEME_CSS } from './defaults'
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

export type MailTemplateNode
  = MailTemplateValueNode
  | MailTemplateComponentNode
  | {
    readonly type: 'if'
    readonly path: readonly string[]
    readonly then: readonly MailTemplateNode[]
    readonly otherwise: readonly MailTemplateNode[]
  }
  | { readonly type: 'foreach', readonly path: readonly string[], readonly item: string, readonly body: readonly MailTemplateNode[] }
  | { readonly type: 'include', readonly template: string }

export type MailTemplateFormat = 'html' | 'text'

export interface CompiledMailTemplate {
  readonly nodes: readonly MailTemplateNode[]
  readonly data: MailTemplateDataObjectShape
}

export type CompiledMailComponent = Readonly<Record<MailTemplateFormat, readonly MailTemplateNode[]>>

export interface CompiledMailRegistry {
  readonly templates: Readonly<Record<string, CompiledMailTemplate>>
  readonly components: Readonly<Record<string, CompiledMailComponent>>
  readonly layouts: Readonly<Partial<Record<MailTemplateFormat, CompiledMailTemplate>>>
  readonly themes: Readonly<Record<string, string>>
}

export interface MailRegistrySources {
  readonly templates: Readonly<Record<string, string>>
  readonly layouts?: Readonly<Partial<Record<MailTemplateFormat, string>>>
  readonly themes?: Readonly<Record<string, string>>
}

export type MailTemplateDataShape
  = { readonly kind: 'value' }
  | { readonly kind: 'json' }
  | { readonly kind: 'list', readonly item: MailTemplateDataShape }
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

interface DirectiveToken {
  readonly type: 'directive'
  readonly name: string
  readonly argument: string
  readonly line: number
}

type ComponentTagToken
  = {
    readonly type: 'componentOpen'
    readonly name: string
    readonly attributes: Readonly<Record<string, readonly MailTemplateValueNode[]>>
    readonly line: number
  }
  | { readonly type: 'componentClose', readonly name: string, readonly line: number }

type TemplateToken = MailTemplateValueNode | DirectiveToken | ComponentTagToken

interface ScannedToken {
  readonly token: TemplateToken
  readonly end: number
}

interface ScanContext {
  readonly template: string
  readonly source: string
  readonly components: ReadonlySet<string>
}

interface IncludeReference {
  readonly template: string
  readonly line: number
}

type OpenBlock
  = { readonly kind: 'if', readonly line: number, readonly path: readonly string[], readonly then: MailTemplateNode[], otherwise?: MailTemplateNode[] }
  | { readonly kind: 'foreach', readonly line: number, readonly path: readonly string[], readonly item: string, readonly body: MailTemplateNode[] }
  | {
    readonly kind: 'component'
    readonly line: number
    readonly name: string
    readonly attributes: Readonly<Record<string, readonly MailTemplateValueNode[]>>
    readonly children: MailTemplateNode[]
  }

type DirectiveBlock = Exclude<OpenBlock['kind'], 'component'>

interface ParsedMailTemplate {
  readonly nodes: readonly MailTemplateNode[]
  readonly includes: readonly IncludeReference[]
  readonly data: MailTemplateDataObjectShape
}

interface LoopShape {
  readonly name: string
  item: MailTemplateDataShape | undefined
}

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
const DIRECTIVE_PATTERN = /\B@(@?)([A-Za-z]\w*)/g
const DIRECTIVE_ARGUMENTS: Readonly<Record<string, string>> = {
  if: 'a data path',
  else: '',
  endif: '',
  foreach: '"path as name"',
  endforeach: '',
  include: 'a Mail template name',
}
const BLOCK_CLOSERS: Readonly<Record<DirectiveBlock, string>> = { if: 'endif', foreach: 'endforeach' }
const FOREACH_ARGUMENT_PATTERN = /^(\S+)\s+as\s+([A-Za-z_]\w*)$/
const TEMPLATE_NAME_PATTERN = /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*$/
const PATH_SEGMENT_PATTERN = /^[A-Za-z_]\w*$/
const VALUE_SHAPE: MailTemplateDataShape = Object.freeze({ kind: 'value' })
const JSON_SHAPE: MailTemplateDataShape = Object.freeze({ kind: 'json' })
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

class DataShapeConflict extends Error {
  readonly path: readonly string[]
  readonly existing: MailTemplateDataShape
  readonly incoming: MailTemplateDataShape

  constructor(path: readonly string[], existing: MailTemplateDataShape, incoming: MailTemplateDataShape) {
    super(`"${path.join('.')}" conflicts`)
    this.path = path
    this.existing = existing
    this.incoming = incoming
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

function findNextMarker(source: string, from: number): { readonly index: number, readonly marker: TemplateMarker } | undefined {
  return TEMPLATE_MARKERS
    .map(({ open, marker }) => ({ index: source.indexOf(open, from), marker }))
    .filter(match => match.index !== -1)
    .sort((left, right) => left.index - right.index)[0]
}

function findNextDirective(source: string, from: number): RegExpExecArray | undefined {
  const pattern = new RegExp(DIRECTIVE_PATTERN.source, DIRECTIVE_PATTERN.flags)
  pattern.lastIndex = from
  return pattern.exec(source) ?? undefined
}

function parsePath(template: string, line: number, expression: string): readonly string[] {
  const segments = expression.trim().split('.')
  if (!segments.every(segment => PATH_SEGMENT_PATTERN.test(segment))) {
    throw new MailTemplateSyntaxError(template, line, `"${expression.trim()}" is not a data path. Use names separated by dots, such as "order.id".`)
  }

  return Object.freeze(segments)
}

function skipDirectiveLineBreak(source: string, index: number): number {
  if (source.startsWith('\r\n', index)) return index + 2
  return source[index] === '\n' ? index + 1 : index
}

function scanDirective(template: string, source: string, match: RegExpExecArray): ScannedToken {
  const [found, escape, name = ''] = match
  const afterName = match.index + found.length
  if (escape) return { token: { type: 'text', value: found.slice(1) }, end: afterName }

  const expected = Object.hasOwn(DIRECTIVE_ARGUMENTS, name) ? DIRECTIVE_ARGUMENTS[name] : undefined
  if (expected === undefined) return { token: { type: 'text', value: found }, end: afterName }

  const line = lineAt(source, match.index)
  if (!expected) {
    return { token: { type: 'directive', name, argument: '', line }, end: skipDirectiveLineBreak(source, afterName) }
  }

  const openIndex = afterName + (/^[ \t]*/.exec(source.slice(afterName))?.[0].length ?? 0)
  const closeIndex = source[openIndex] === '(' ? source.indexOf(')', openIndex) : -1
  if (closeIndex === -1 || source.slice(openIndex, closeIndex).includes('\n')) {
    throw new MailTemplateSyntaxError(template, line, `"@${name}" needs ${expected} in parentheses.`)
  }

  return {
    token: { type: 'directive', name, argument: source.slice(openIndex + 1, closeIndex).trim(), line },
    end: skipDirectiveLineBreak(source, closeIndex + 1),
  }
}

function scanOutput(
  template: string,
  source: string,
  index: number,
  delimiter: Delimiter,
  line: number,
): { readonly token: MailTemplateValueNode, readonly end: number } {
  const expressionStart = index + delimiter.open.length
  const closeIndex = source.indexOf(delimiter.close, expressionStart)
  if (closeIndex === -1) {
    throw new MailTemplateSyntaxError(template, line, `"${delimiter.open}" is not closed with "${delimiter.close}".`)
  }

  return {
    token: { type: 'output', path: parsePath(template, line, source.slice(expressionStart, closeIndex)), escaped: delimiter.escaped },
    end: closeIndex + delimiter.close.length,
  }
}

function compileValueNodes(template: string, line: number, source: string): readonly MailTemplateValueNode[] {
  const nodes: MailTemplateValueNode[] = []
  let cursor = 0
  for (let match = findNextDelimiter(source, cursor); match; match = findNextDelimiter(source, cursor)) {
    if (match.index > cursor) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor, match.index) }))
    const output = scanOutput(template, source, match.index, match.delimiter, line)
    nodes.push(Object.freeze(output.token))
    cursor = output.end
  }

  if (cursor < source.length) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor) }))
  return Object.freeze(nodes)
}

function matchTag(pattern: RegExp, source: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(source)
}

function malformedTagError(context: ScanContext, line: number): MailTemplateSyntaxError {
  return new MailTemplateSyntaxError(context.template, line, 'Malformed Mail component tag. Write it as <mail::name attribute="value">.')
}

function compileAttributes(
  context: ScanContext,
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

function scanComponentOpen(context: ScanContext, index: number, line: number): ScannedToken {
  const tag = matchTag(COMPONENT_OPEN_TAG_PATTERN, context.source, index)
  if (!tag) throw malformedTagError(context, line)
  const [match, name = '', attributes = ''] = tag
  if (!context.components.has(name)) {
    throw new MailTemplateSyntaxError(context.template, line, `<mail::${name}> is not a Mail component.`)
  }

  return {
    token: { type: 'componentOpen', name, attributes: compileAttributes(context, line, attributes), line },
    end: index + match.length,
  }
}

function scanComponentClose(context: ScanContext, index: number, line: number): ScannedToken {
  const tag = matchTag(COMPONENT_CLOSE_TAG_PATTERN, context.source, index)
  if (!tag) throw malformedTagError(context, line)
  const [match, name = ''] = tag
  return { token: { type: 'componentClose', name, line }, end: index + match.length }
}

function scanMarker(context: ScanContext, index: number, marker: TemplateMarker): ScannedToken {
  const line = lineAt(context.source, index)
  if (marker.kind === 'componentOpen') return scanComponentOpen(context, index, line)
  if (marker.kind === 'componentClose') return scanComponentClose(context, index, line)
  return scanOutput(context.template, context.source, index, marker.delimiter, line)
}

function* scanTemplate(context: ScanContext): Generator<TemplateToken> {
  const { template, source } = context
  let cursor = 0
  while (cursor < source.length) {
    const marker = findNextMarker(source, cursor)
    const directive = findNextDirective(source, cursor)
    const start = Math.min(marker?.index ?? source.length, directive?.index ?? source.length)
    if (start > cursor) yield { type: 'text', value: source.slice(cursor, start) }
    if (start === source.length) return

    const scanned = directive?.index === start
      ? scanDirective(template, source, directive)
      : marker && scanMarker(context, start, marker.marker)
    if (!scanned) return
    yield scanned.token
    cursor = scanned.end
  }
}

function blockNodes(block: OpenBlock): MailTemplateNode[] {
  if (block.kind === 'component') return block.children
  if (block.kind === 'foreach') return block.body
  return block.otherwise ?? block.then
}

function openForeach(template: string, token: DirectiveToken): OpenBlock {
  const match = FOREACH_ARGUMENT_PATTERN.exec(token.argument)
  if (!match?.[1] || !match[2]) {
    throw new MailTemplateSyntaxError(template, token.line, '"@foreach" needs "path as name" in parentheses, such as "@foreach (order.items as item)".')
  }

  return { kind: 'foreach', line: token.line, path: parsePath(template, token.line, match[1]), item: match[2], body: [] }
}

function openElse(template: string, blocks: readonly OpenBlock[], token: DirectiveToken): void {
  const block = blocks.at(-1)
  if (block?.kind !== 'if' || block.otherwise) {
    throw new MailTemplateSyntaxError(template, token.line, '"@else" has no matching "@if".')
  }

  block.otherwise = []
}

function closeBlock(template: string, blocks: OpenBlock[], token: DirectiveToken, directive: DirectiveBlock): MailTemplateNode {
  const block = blocks.pop()
  if (block?.kind !== directive) {
    throw new MailTemplateSyntaxError(template, token.line, `"@${token.name}" has no matching "@${directive}".`)
  }

  if (block.kind === 'foreach') {
    return Object.freeze({ type: 'foreach', path: block.path, item: block.item, body: Object.freeze(block.body) })
  }

  return Object.freeze({ type: 'if', path: block.path, then: Object.freeze(block.then), otherwise: Object.freeze(block.otherwise ?? []) })
}

function closeComponent(template: string, blocks: OpenBlock[], token: Extract<ComponentTagToken, { readonly type: 'componentClose' }>): MailTemplateNode {
  const block = blocks.pop()
  if (block?.kind !== 'component' || block.name !== token.name) {
    throw new MailTemplateSyntaxError(template, token.line, `</mail::${token.name}> does not close an open <mail::${token.name}>.`)
  }

  return Object.freeze({ type: 'component', name: block.name, attributes: block.attributes, children: Object.freeze(block.children) })
}

function parseInclude(template: string, token: DirectiveToken): IncludeReference {
  if (!TEMPLATE_NAME_PATTERN.test(token.argument)) {
    throw new MailTemplateSyntaxError(template, token.line, `"${token.argument}" is not a Mail template name, such as "partials/order-summary".`)
  }

  return { template: token.argument, line: token.line }
}

function unclosedBlockError(template: string, block: OpenBlock): MailTemplateSyntaxError {
  if (block.kind === 'component') {
    return new MailTemplateSyntaxError(template, block.line, `<mail::${block.name}> is not closed with </mail::${block.name}>.`)
  }

  return new MailTemplateSyntaxError(template, block.line, `"@${block.kind}" is not closed with "@${BLOCK_CLOSERS[block.kind]}".`)
}

function parseTemplate(context: ScanContext): Pick<ParsedMailTemplate, 'nodes' | 'includes'> {
  const { template } = context
  const root: MailTemplateNode[] = []
  const blocks: OpenBlock[] = []
  const includes: IncludeReference[] = []
  const append = (node: MailTemplateNode): void => {
    const block = blocks.at(-1)
    ;(block ? blockNodes(block) : root).push(Object.freeze(node))
  }

  for (const token of scanTemplate(context)) {
    if (token.type === 'componentOpen') blocks.push({ kind: 'component', line: token.line, name: token.name, attributes: token.attributes, children: [] })
    else if (token.type === 'componentClose') append(closeComponent(template, blocks, token))
    else if (token.type !== 'directive') append(token)
    else if (token.name === 'if') blocks.push({ kind: 'if', line: token.line, path: parsePath(template, token.line, token.argument), then: [] })
    else if (token.name === 'foreach') blocks.push(openForeach(template, token))
    else if (token.name === 'else') openElse(template, blocks, token)
    else if (token.name === 'endif') append(closeBlock(template, blocks, token, 'if'))
    else if (token.name === 'endforeach') append(closeBlock(template, blocks, token, 'foreach'))
    else if (token.name === 'include') {
      const include = parseInclude(template, token)
      includes.push(include)
      append({ type: 'include', template: include.template })
    }
  }

  const unclosed = blocks.at(-1)
  if (unclosed) throw unclosedBlockError(template, unclosed)

  return { nodes: Object.freeze(root), includes }
}

function describeShape(shape: MailTemplateDataShape): string {
  if (shape.kind === 'value') return 'a value'
  if (shape.kind === 'list') return 'a list'
  return 'an object'
}

function mergeObjectShapes(
  existing: MailTemplateDataObjectShape,
  incoming: MailTemplateDataObjectShape,
  path: readonly string[],
): MailTemplateDataObjectShape {
  const properties = new Map(Object.entries(existing.properties))
  for (const [name, shape] of Object.entries(incoming.properties)) {
    properties.set(name, mergeShapes(properties.get(name), shape, [...path, name]))
  }

  return { kind: 'object', properties: Object.fromEntries(properties) }
}

function mergeShapes(
  existing: MailTemplateDataShape | undefined,
  incoming: MailTemplateDataShape,
  path: readonly string[],
): MailTemplateDataShape {
  if (!existing || existing.kind === 'json') return incoming
  if (incoming.kind === 'json') return existing
  if (existing.kind === 'value' && incoming.kind === 'value') return existing
  if (existing.kind === 'list' && incoming.kind === 'list') {
    return { kind: 'list', item: mergeShapes(existing.item, incoming.item, path) }
  }
  if (existing.kind === 'object' && incoming.kind === 'object') return mergeObjectShapes(existing, incoming, path)
  throw new DataShapeConflict(path, existing, incoming)
}

function findLoop<TLoop extends { readonly name: string }>(loops: readonly TLoop[], name: string | undefined): TLoop | undefined {
  return [...loops].reverse().find(loop => loop.name === name)
}

function nestShape(path: readonly string[], leaf: MailTemplateDataShape): MailTemplateDataShape {
  const [segment, ...rest] = path
  if (!segment) return leaf
  return { kind: 'object', properties: { [segment]: nestShape(rest, leaf) } }
}

function conflictError(template: string, conflict: DataShapeConflict, path: readonly string[]): MailError {
  return new MailError(
    `[@holo-js/mail] Mail template "${template}" uses "${path.join('.')}" both as ${describeShape(conflict.existing)} and as ${describeShape(conflict.incoming)}.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

class TemplateDataCollector {
  readonly #template: string
  readonly #loops: LoopShape[] = []
  #data: MailTemplateDataObjectShape = { kind: 'object', properties: {} }

  constructor(template: string) {
    this.#template = template
  }

  collect(nodes: readonly MailTemplateNode[]): MailTemplateDataObjectShape {
    for (const node of nodes) this.#collectNode(node)
    return this.#data
  }

  #collectNode(node: MailTemplateNode): void {
    if (node.type === 'output') this.#use(node.path, VALUE_SHAPE)
    if (node.type === 'component') {
      for (const value of Object.values(node.attributes)) this.collect(value)
      this.collect(node.children)
    }
    if (node.type === 'if') {
      this.#use(node.path, JSON_SHAPE)
      this.collect(node.then)
      this.collect(node.otherwise)
    }
    if (node.type === 'foreach') {
      const loop: LoopShape = { name: node.item, item: undefined }
      this.#loops.push(loop)
      this.collect(node.body)
      this.#loops.pop()
      this.#use(node.path, { kind: 'list', item: loop.item ?? JSON_SHAPE })
    }
  }

  #use(path: readonly string[], leaf: MailTemplateDataShape): void {
    const [first, ...rest] = path
    const loop = findLoop(this.#loops, first)
    try {
      const usage = nestShape(loop ? rest : path, leaf)
      if (loop) loop.item = mergeShapes(loop.item, usage, [])
      else if (usage.kind === 'object') this.#data = mergeObjectShapes(this.#data, usage, [])
    } catch (error) {
      if (error instanceof DataShapeConflict) throw conflictError(this.#template, error, path)
      throw error
    }
  }
}

function parseMailTemplate(template: string, source: string, components: ReadonlySet<string>): ParsedMailTemplate {
  const { nodes, includes } = parseTemplate({ template, source, components })
  return { nodes, includes, data: new TemplateDataCollector(template).collect(nodes) }
}

function resolveTemplateData(
  template: string,
  parsed: Readonly<Record<string, ParsedMailTemplate>>,
  trail: readonly string[],
): MailTemplateDataObjectShape {
  const current = parsed[template]!
  const chain = [...trail, template]
  return current.includes.reduce((data, include) => {
    if (!Object.hasOwn(parsed, include.template)) {
      throw new MailTemplateSyntaxError(template, include.line, `"@include (${include.template})" names a Mail template that does not exist.`)
    }
    if (chain.includes(include.template)) {
      const cycle = [...chain.slice(chain.indexOf(include.template)), include.template].join(' -> ')
      throw new MailTemplateSyntaxError(template, include.line, `"@include (${include.template})" creates an include cycle: ${cycle}.`)
    }

    try {
      return mergeObjectShapes(data, resolveTemplateData(include.template, parsed, chain), [])
    } catch (error) {
      if (error instanceof DataShapeConflict) throw conflictError(template, error, error.path)
      throw error
    }
  }, current.data)
}

function compileMailComponent(
  name: string,
  source: MailComponentSource,
  components: ReadonlySet<string>,
): CompiledMailComponent {
  const template = `components/${name}`
  return Object.freeze({
    html: parseTemplate({ template, source: source.html, components }).nodes,
    text: parseTemplate({ template, source: source.text, components }).nodes,
  })
}

const BUILT_IN_MAIL_COMPONENT_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILT_IN_MAIL_COMPONENTS))

const MAIL_LAYOUT_FILE_NAMES: Readonly<Record<MailTemplateFormat, string>> = {
  html: 'layout.html',
  text: 'layout.txt',
}

function compileWithTemplates(
  name: string,
  source: string,
  parsed: Readonly<Record<string, ParsedMailTemplate>>,
): CompiledMailTemplate {
  const template = parseMailTemplate(name, source, BUILT_IN_MAIL_COMPONENT_NAMES)
  return Object.freeze({ nodes: template.nodes, data: resolveTemplateData(name, { ...parsed, [name]: template }, []) })
}

const DEFAULT_MAIL_LAYOUTS: Readonly<Record<MailTemplateFormat, CompiledMailTemplate>> = Object.freeze({
  html: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.html, DEFAULT_MAIL_LAYOUT_HTML, {}),
  text: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.text, DEFAULT_MAIL_LAYOUT_TEXT, {}),
})

function compileMailLayouts(
  layouts: MailRegistrySources['layouts'] = {},
  parsed: Readonly<Record<string, ParsedMailTemplate>>,
): CompiledMailRegistry['layouts'] {
  return Object.freeze({
    ...(typeof layouts.html === 'string' ? { html: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.html, layouts.html, parsed) } : {}),
    ...(typeof layouts.text === 'string' ? { text: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.text, layouts.text, parsed) } : {}),
  })
}

export function compileMailRegistry(sources: MailRegistrySources): CompiledMailRegistry {
  const parsed = Object.fromEntries(Object.entries(sources.templates).map(([name, source]) => {
    return [name, parseMailTemplate(name, source, BUILT_IN_MAIL_COMPONENT_NAMES)]
  }))

  return Object.freeze({
    templates: Object.freeze(Object.fromEntries(Object.entries(parsed).map(([name, template]) => {
      return [name, Object.freeze({ nodes: template.nodes, data: resolveTemplateData(name, parsed, []) })]
    }))),
    components: Object.freeze(Object.fromEntries(Object.entries(BUILT_IN_MAIL_COMPONENTS).map(([name, source]) => {
      return [name, compileMailComponent(name, source, BUILT_IN_MAIL_COMPONENT_NAMES)]
    }))),
    layouts: compileMailLayouts(sources.layouts, parsed),
    themes: Object.freeze({ ...sources.themes }),
  })
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
  const loop = findLoop(context.loops, first)
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
  const component = Object.hasOwn(context.registry.components, name) ? context.registry.components[name] : undefined
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

function renderLoop(context: RenderContext, node: Extract<MailTemplateNode, { readonly type: 'foreach' }>): string {
  const items = resolveDataPath(context, node.path)
  if (!Array.isArray(items)) throw invalidDataError(context, 'a list', node.path)
  return items.map((value: MailJsonValue) => renderNodes(
    { ...context, loops: [...context.loops, { name: node.item, value }] },
    node.body,
  )).join('')
}

function renderNode(context: RenderContext, node: MailTemplateNode): string {
  if (node.type === 'text') return node.value
  if (node.type === 'output') return renderOutput(context, node.path, node.escaped)
  if (node.type === 'component') return renderComponent(context, node)
  if (node.type === 'if') return renderNodes(context, resolveDataPath(context, node.path) ? node.then : node.otherwise)
  if (node.type === 'foreach') return renderLoop(context, node)
  return renderMailTemplate(context.registry, node.template, context.data, context.format)
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
  const template = Object.hasOwn(registry.templates, name) ? registry.templates[name] : undefined
  if (!template) {
    throw new MailError(
      `[@holo-js/mail] Mail template "${name}" is not registered. Run "holo prepare" after adding it under server/mail/templates.`,
      'MAIL_TEMPLATE_NOT_FOUND',
    )
  }

  return renderNodes({ registry, template: name, format, data, loops: [] }, template.nodes)
}

export function renderMailLayout(registry: CompiledMailRegistry, format: MailTemplateFormat, data: MailJsonObject): string {
  const layout = registry.layouts[format] ?? DEFAULT_MAIL_LAYOUTS[format]
  return renderNodes({ registry, template: MAIL_LAYOUT_FILE_NAMES[format], format, data, loops: [] }, layout.nodes)
}

export function resolveMailTheme(registry: CompiledMailRegistry, name: string): string {
  if (Object.hasOwn(registry.themes, name)) return registry.themes[name] ?? ''
  if (name === 'default') return DEFAULT_MAIL_THEME_CSS
  throw new MailError(
    `[@holo-js/mail] Mail theme "${name}" is not registered. Run "holo prepare" after adding it under server/mail/themes.`,
    'MAIL_THEME_NOT_FOUND',
  )
}
