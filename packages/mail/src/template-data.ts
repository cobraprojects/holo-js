import { MailError } from './errors'
import {
  findInnermostLoop,
  MailTemplateSyntaxError,
  type MailTemplateNode,
  type ParsedTemplateSyntax,
} from './template-syntax'

export type MailTemplateDataShape
  = { readonly kind: 'value' }
  | { readonly kind: 'json' }
  | { readonly kind: 'list', readonly item: MailTemplateDataShape }
  | MailTemplateDataObjectShape

export interface MailTemplateDataObjectShape {
  readonly kind: 'object'
  readonly properties: Readonly<Record<string, MailTemplateDataShape>>
}

interface LoopShape {
  readonly name: string
  item: MailTemplateDataShape | undefined
}

const VALUE_SHAPE: MailTemplateDataShape = Object.freeze({ kind: 'value' })
const JSON_SHAPE: MailTemplateDataShape = Object.freeze({ kind: 'json' })

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

type IncludedTemplateData = (template: string) => MailTemplateDataObjectShape

class TemplateDataCollector {
  readonly #template: string
  readonly #includedData: IncludedTemplateData
  readonly #loops: LoopShape[] = []
  #data: MailTemplateDataObjectShape = { kind: 'object', properties: {} }

  constructor(template: string, includedData: IncludedTemplateData) {
    this.#template = template
    this.#includedData = includedData
  }

  collect(nodes: readonly MailTemplateNode[]): MailTemplateDataObjectShape {
    for (const node of nodes) this.#collectNode(node)
    return this.#data
  }

  #collectNode(node: MailTemplateNode): void {
    switch (node.type) {
      case 'output':
        this.#use(node.path, VALUE_SHAPE)
        return
      case 'component':
        for (const value of Object.values(node.attributes)) this.collect(value)
        this.collect(node.children)
        return
      case 'if':
        this.#use(node.path, JSON_SHAPE)
        this.collect(node.then)
        this.collect(node.otherwise)
        return
      case 'foreach': {
        const loop: LoopShape = { name: node.item, item: undefined }
        this.#loops.push(loop)
        this.collect(node.body)
        this.#loops.pop()
        this.#use(node.path, { kind: 'list', item: loop.item ?? JSON_SHAPE })
        return
      }
      case 'include':
        this.#include(this.#includedData(node.template))
        return
      case 'text':
    }
  }

  #use(path: readonly string[], leaf: MailTemplateDataShape): void {
    const [first, ...rest] = path
    const loop = findInnermostLoop(this.#loops, first)
    try {
      const usage = nestShape(loop ? rest : path, leaf)
      if (loop) loop.item = mergeShapes(loop.item, usage, [])
      else if (usage.kind === 'object') this.#data = mergeObjectShapes(this.#data, usage, [])
    } catch (error) {
      if (error instanceof DataShapeConflict) throw conflictError(this.#template, error, path)
      throw error
    }
  }

  #include(included: MailTemplateDataObjectShape): void {
    for (const [name, shape] of Object.entries(included.properties)) {
      const loop = findInnermostLoop(this.#loops, name)
      try {
        if (loop) loop.item = mergeShapes(loop.item, shape, [name])
        else this.#data = mergeObjectShapes(this.#data, { kind: 'object', properties: { [name]: shape } }, [])
      } catch (error) {
        if (error instanceof DataShapeConflict) throw conflictError(this.#template, error, error.path)
        throw error
      }
    }
  }
}

function assertIncludesResolve(
  template: string,
  parsed: Readonly<Record<string, ParsedTemplateSyntax>>,
  chain: readonly string[],
): void {
  for (const include of parsed[template]?.includes ?? []) {
    if (!Object.hasOwn(parsed, include.template)) {
      throw new MailTemplateSyntaxError(template, include.line, `"@include (${include.template})" names a Mail template that does not exist.`)
    }
    if (chain.includes(include.template)) {
      const cycle = [...chain.slice(chain.indexOf(include.template)), include.template].join(' -> ')
      throw new MailTemplateSyntaxError(template, include.line, `"@include (${include.template})" creates an include cycle: ${cycle}.`)
    }

    assertIncludesResolve(include.template, parsed, [...chain, include.template])
  }
}

export function resolveTemplateData(
  parsed: Readonly<Record<string, ParsedTemplateSyntax>>,
): (template: string) => MailTemplateDataObjectShape {
  const resolved = new Map<string, MailTemplateDataObjectShape>()
  const resolve = (template: string): MailTemplateDataObjectShape => {
    const cached = resolved.get(template)
    if (cached) return cached

    assertIncludesResolve(template, parsed, [template])
    const data = new TemplateDataCollector(template, resolve).collect(parsed[template]?.nodes ?? [])
    resolved.set(template, data)
    return data
  }

  return resolve
}
