import type { MailJsonObject, MailJsonValue } from './contracts-types'
import { DEFAULT_MAIL_LAYOUT_HTML, DEFAULT_MAIL_LAYOUT_TEXT, DEFAULT_MAIL_THEME_CSS } from './defaults'
import { MailError } from './errors'

export type MailTemplateNode
  = { readonly type: 'text', readonly value: string }
  | { readonly type: 'output', readonly path: readonly string[], readonly escaped: boolean }

export interface CompiledMailTemplate {
  readonly nodes: readonly MailTemplateNode[]
  readonly data: MailTemplateDataObjectShape
}

export type MailLayoutFormat = 'html' | 'text'

export interface CompiledMailRegistry {
  readonly templates: Readonly<Record<string, CompiledMailTemplate>>
  readonly layouts: Readonly<Partial<Record<MailLayoutFormat, CompiledMailTemplate>>>
  readonly themes: Readonly<Record<string, string>>
}

export interface MailRegistrySources {
  readonly templates: Readonly<Record<string, string>>
  readonly layouts?: Readonly<Partial<Record<MailLayoutFormat, string>>>
  readonly themes?: Readonly<Record<string, string>>
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

const DELIMITERS: readonly Delimiter[] = [
  { open: '{!!', close: '!!}', escaped: false },
  { open: '{{', close: '}}', escaped: true },
]
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

function compileMailTemplate(name: string, source: string): CompiledMailTemplate {
  const nodes: MailTemplateNode[] = []
  let cursor = 0
  for (let match = findNextDelimiter(source, cursor); match; match = findNextDelimiter(source, cursor)) {
    const { index, delimiter } = match
    const line = lineAt(source, index)
    const expressionStart = index + delimiter.open.length
    const closeIndex = source.indexOf(delimiter.close, expressionStart)
    if (closeIndex === -1) {
      throw new MailTemplateSyntaxError(name, line, `"${delimiter.open}" is not closed with "${delimiter.close}".`)
    }

    if (index > cursor) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor, index) }))
    nodes.push(Object.freeze({
      type: 'output',
      path: parsePath(name, line, source.slice(expressionStart, closeIndex)),
      escaped: delimiter.escaped,
    }))
    cursor = closeIndex + delimiter.close.length
  }

  if (cursor < source.length) nodes.push(Object.freeze({ type: 'text', value: source.slice(cursor) }))
  return Object.freeze({
    nodes: Object.freeze(nodes),
    data: describeTemplateData(name, nodes),
  })
}

const MAIL_LAYOUT_FILE_NAMES: Readonly<Record<MailLayoutFormat, string>> = {
  html: 'layout.html',
  text: 'layout.txt',
}

const DEFAULT_MAIL_LAYOUTS: Readonly<Record<MailLayoutFormat, CompiledMailTemplate>> = Object.freeze({
  html: compileMailTemplate(MAIL_LAYOUT_FILE_NAMES.html, DEFAULT_MAIL_LAYOUT_HTML),
  text: compileMailTemplate(MAIL_LAYOUT_FILE_NAMES.text, DEFAULT_MAIL_LAYOUT_TEXT),
})

function compileMailLayouts(layouts: MailRegistrySources['layouts'] = {}): CompiledMailRegistry['layouts'] {
  return Object.freeze({
    ...(typeof layouts.html === 'string' ? { html: compileMailTemplate(MAIL_LAYOUT_FILE_NAMES.html, layouts.html) } : {}),
    ...(typeof layouts.text === 'string' ? { text: compileMailTemplate(MAIL_LAYOUT_FILE_NAMES.text, layouts.text) } : {}),
  })
}

export function compileMailRegistry(sources: MailRegistrySources): CompiledMailRegistry {
  return Object.freeze({
    templates: Object.freeze(Object.fromEntries(Object.entries(sources.templates).map(([name, source]) => {
      return [name, compileMailTemplate(name, source)]
    }))),
    layouts: compileMailLayouts(sources.layouts),
    themes: Object.freeze({ ...sources.themes }),
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

function describeTemplateData(name: string, nodes: readonly MailTemplateNode[]): MailTemplateDataObjectShape {
  const properties: Record<string, MailTemplateDataShape> = {}
  for (const node of nodes) {
    if (node.type === 'output') addPathToShape(name, properties, node.path)
  }

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

export function renderMailTemplate(registry: CompiledMailRegistry, name: string, data: MailJsonObject): string {
  const template = Object.hasOwn(registry.templates, name) ? registry.templates[name] : undefined
  if (!template) {
    throw new MailError(
      `[@holo-js/mail] Mail template "${name}" is not registered. Run "holo prepare" after adding it under server/mail/templates.`,
      'MAIL_TEMPLATE_NOT_FOUND',
    )
  }

  return renderCompiledTemplate(name, template, data)
}

function renderCompiledTemplate(name: string, template: CompiledMailTemplate, data: MailJsonObject): string {
  return template.nodes.map(node => node.type === 'text'
    ? node.value
    : renderOutput(name, data, node.path, node.escaped)).join('')
}

export function renderMailLayout(registry: CompiledMailRegistry, format: MailLayoutFormat, data: MailJsonObject): string {
  return renderCompiledTemplate(MAIL_LAYOUT_FILE_NAMES[format], registry.layouts[format] ?? DEFAULT_MAIL_LAYOUTS[format], data)
}

export function resolveMailTheme(registry: CompiledMailRegistry, name: string): string {
  if (Object.hasOwn(registry.themes, name)) return registry.themes[name] ?? ''
  if (name === 'default') return DEFAULT_MAIL_THEME_CSS
  throw new MailError(
    `[@holo-js/mail] Mail theme "${name}" is not registered. Run "holo prepare" after adding it under server/mail/themes.`,
    'MAIL_THEME_NOT_FOUND',
  )
}
