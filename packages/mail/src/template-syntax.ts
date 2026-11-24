import { MailError } from './errors'
import { findOwnEntry } from './own-entry'
import { isMailTemplateName } from './template-name'

export type MailTemplateValueNode
  = { readonly type: 'text', readonly value: string }
  | { readonly type: 'output', readonly path: readonly string[], readonly escaped: boolean }

export interface MailTemplateComponentNode {
  readonly type: 'component'
  readonly name: string
  readonly attributes: Readonly<Record<string, readonly MailTemplateValueNode[]>>
  readonly children: readonly MailTemplateNode[]
}

export interface MailTemplateIfNode {
  readonly type: 'if'
  readonly path: readonly string[]
  readonly then: readonly MailTemplateNode[]
  readonly otherwise: readonly MailTemplateNode[]
}

export interface MailTemplateForeachNode {
  readonly type: 'foreach'
  readonly path: readonly string[]
  readonly item: string
  readonly body: readonly MailTemplateNode[]
}

export interface MailTemplateIncludeNode {
  readonly type: 'include'
  readonly template: string
}

export type MailTemplateNode
  = MailTemplateValueNode
  | MailTemplateComponentNode
  | MailTemplateIfNode
  | MailTemplateForeachNode
  | MailTemplateIncludeNode

export type MailTemplateFormat = 'html' | 'text'

export interface IncludeReference {
  readonly template: string
  readonly line: number
}

export interface ParsedTemplateSyntax {
  readonly nodes: readonly MailTemplateNode[]
  readonly includes: readonly IncludeReference[]
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

interface MarkerOpening<TMarker> {
  readonly open: string
  readonly marker: TMarker
}

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

const DELIMITERS: readonly Delimiter[] = [
  { open: '{!!', close: '!!}', escaped: false },
  { open: '{{', close: '}}', escaped: true },
]
const DELIMITER_OPENINGS: readonly MarkerOpening<Delimiter>[] = DELIMITERS.map(delimiter => ({ open: delimiter.open, marker: delimiter }))
const TEMPLATE_MARKERS: readonly MarkerOpening<TemplateMarker>[] = [
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
const UNSUPPORTED_BLADE_DIRECTIVES: ReadonlySet<string> = new Set([
  'elseif', 'unless', 'endunless', 'isset', 'endisset', 'empty', 'endempty', 'forelse', 'endforelse',
  'for', 'endfor', 'while', 'endwhile', 'switch', 'case', 'break', 'continue', 'default', 'endswitch',
  'php', 'endphp', 'lang', 'choice', 'auth', 'endauth', 'guest', 'endguest', 'env', 'endenv', 'production', 'endproduction',
  'section', 'endsection', 'show', 'yield', 'extends', 'parent', 'component', 'endcomponent', 'slot', 'endslot', 'props', 'aware',
  'verbatim', 'endverbatim', 'json', 'method', 'csrf', 'error', 'enderror', 'once', 'endonce',
  'push', 'endpush', 'prepend', 'endprepend', 'stack', 'class', 'style',
])
const BLOCK_CLOSERS: Readonly<Record<DirectiveBlock, string>> = { if: 'endif', foreach: 'endforeach' }
const FOREACH_ARGUMENT_PATTERN = /^(\S+)\s+as\s+([A-Za-z_]\w*)$/
const PATH_SEGMENT_PATTERN = /^[A-Za-z_]\w*$/
const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

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

export function findInnermostLoop<TLoop extends { readonly name: string }>(
  loops: readonly TLoop[],
  name: string | undefined,
): TLoop | undefined {
  return [...loops].reverse().find(loop => loop.name === name)
}

export function childNodeLists(node: MailTemplateNode): readonly (readonly MailTemplateNode[])[] {
  switch (node.type) {
    case 'component': return [node.children]
    case 'if': return [node.then, node.otherwise]
    case 'foreach': return [node.body]
    case 'text':
    case 'output':
    case 'include': return []
  }
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function findNextOpening<TMarker>(
  source: string,
  from: number,
  openings: readonly MarkerOpening<TMarker>[],
): { readonly index: number, readonly marker: TMarker } | undefined {
  return openings
    .map(({ open, marker }) => ({ index: source.indexOf(open, from), marker }))
    .filter(match => match.index !== -1)
    .sort((left, right) => left.index - right.index)[0]
}

function findNextDirective(source: string, from: number): RegExpExecArray | undefined {
  const pattern = new RegExp(DIRECTIVE_PATTERN.source, DIRECTIVE_PATTERN.flags)
  pattern.lastIndex = from
  return pattern.exec(source) ?? undefined
}

function assertNotReservedPathSegment(template: string, line: number, segment: string): void {
  if (RESERVED_NAMES.has(segment)) {
    throw new MailTemplateSyntaxError(template, line, `"${segment}" is reserved and cannot be used in a data path.`)
  }
}

function parsePath(template: string, line: number, expression: string): readonly string[] {
  const segments = expression.trim().split('.')
  if (!segments.every(segment => PATH_SEGMENT_PATTERN.test(segment))) {
    throw new MailTemplateSyntaxError(template, line, `"${expression.trim()}" is not a data path. Use names separated by dots, such as "order.id".`)
  }

  for (const segment of segments) assertNotReservedPathSegment(template, line, segment)
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

  const line = lineAt(source, match.index)
  if (UNSUPPORTED_BLADE_DIRECTIVES.has(name)) {
    throw new MailTemplateSyntaxError(template, line, `"@${name}" is not supported in Mail templates.`)
  }

  const expected = findOwnEntry(DIRECTIVE_ARGUMENTS, name)
  if (expected === undefined) return { token: { type: 'text', value: found }, end: afterName }

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
  for (let match = findNextOpening(source, cursor, DELIMITER_OPENINGS); match; match = findNextOpening(source, cursor, DELIMITER_OPENINGS)) {
    if (match.index > cursor) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor, match.index) }))
    const output = scanOutput(template, source, match.index, match.marker, line)
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
  const attributes = new Map<string, readonly MailTemplateValueNode[]>()
  for (const [, name = '', value = ''] of source.matchAll(COMPONENT_ATTRIBUTE_PATTERN)) {
    if (RESERVED_NAMES.has(name)) {
      throw new MailTemplateSyntaxError(context.template, line, `Mail component attribute "${name}" is reserved.`)
    }
    if (attributes.has(name)) {
      throw new MailTemplateSyntaxError(context.template, line, `Mail component attribute "${name}" is set more than once.`)
    }
    attributes.set(name, compileValueNodes(context.template, line, value))
  }

  return Object.freeze(Object.fromEntries(attributes))
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
  switch (marker.kind) {
    case 'componentOpen': return scanComponentOpen(context, index, line)
    case 'componentClose': return scanComponentClose(context, index, line)
    case 'output': return scanOutput(context.template, context.source, index, marker.delimiter, line)
  }
}

function* scanTemplate(context: ScanContext): Generator<TemplateToken> {
  const { template, source } = context
  let cursor = 0
  while (cursor < source.length) {
    const marker = findNextOpening(source, cursor, TEMPLATE_MARKERS)
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
  switch (block.kind) {
    case 'component': return block.children
    case 'foreach': return block.body
    case 'if': return block.otherwise ?? block.then
  }
}

function openForeach(template: string, token: DirectiveToken): OpenBlock {
  const match = FOREACH_ARGUMENT_PATTERN.exec(token.argument)
  if (!match?.[1] || !match[2]) {
    throw new MailTemplateSyntaxError(template, token.line, '"@foreach" needs "path as name" in parentheses, such as "@foreach (order.items as item)".')
  }

  const path = parsePath(template, token.line, match[1])
  assertNotReservedPathSegment(template, token.line, match[2])
  return { kind: 'foreach', line: token.line, path, item: match[2], body: [] }
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
  if (!isMailTemplateName(token.argument)) {
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

export function parseTemplateSyntax(template: string, source: string, components: ReadonlySet<string>): ParsedTemplateSyntax {
  const root: MailTemplateNode[] = []
  const blocks: OpenBlock[] = []
  const includes: IncludeReference[] = []
  const append = (node: MailTemplateNode): void => {
    const block = blocks.at(-1)
    ;(block ? blockNodes(block) : root).push(Object.freeze(node))
  }

  for (const token of scanTemplate({ template, source, components })) {
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
