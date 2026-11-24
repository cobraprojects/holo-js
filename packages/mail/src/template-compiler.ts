import { resolveMailComponentSources, type MailComponentFiles, type MailComponentSource } from './components'
import { DEFAULT_MAIL_SOURCES } from './defaults'
import { MailError } from './errors'
import { isMailTemplateName } from './template-name'
import { resolveTemplateData, type MailTemplateDataObjectShape } from './template-data'
import {
  childNodeLists,
  missingIncludedTemplateError,
  parseTemplateSyntax,
  type MailTemplateFormat,
  type MailTemplateNode,
  type ParsedTemplateSyntax,
} from './template-syntax'

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
  readonly components?: Readonly<Record<string, MailComponentFiles>>
  readonly layouts?: Readonly<Partial<Record<MailTemplateFormat, string>>>
  readonly themes?: Readonly<Record<string, string>>
}

export const MAIL_LAYOUT_FILE_NAMES: Readonly<Record<MailTemplateFormat, string>> = {
  html: 'layout.html',
  text: 'layout.txt',
}

interface MailTemplateNames {
  readonly components: ReadonlySet<string>
  readonly templates: ReadonlySet<string>
}

function parseMailComponentForm(file: string, source: string, names: MailTemplateNames): readonly MailTemplateNode[] {
  const parsed = parseTemplateSyntax(file, source, names.components)
  const missing = parsed.includes.find(include => !names.templates.has(include.template))
  if (missing) {
    throw missingIncludedTemplateError(file, missing)
  }
  return parsed.nodes
}

function compileMailComponent(name: string, source: MailComponentSource, names: MailTemplateNames): CompiledMailComponent {
  return Object.freeze({
    html: parseMailComponentForm(`components/${name}.html`, source.html, names),
    text: parseMailComponentForm(`components/${name}.txt`, source.text, names),
  })
}

interface MailReferenceNode {
  readonly name: string
  readonly nodes: readonly MailTemplateNode[]
}

type MailReferenceGraph = ReadonlyMap<string, MailReferenceNode>

function componentReferenceKey(name: string): string {
  return `<mail::${name}>`
}

function collectReferences(nodes: readonly MailTemplateNode[], references: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type === 'component') references.add(componentReferenceKey(node.name))
    if (node.type === 'include') references.add(node.template)
    for (const children of childNodeLists(node)) collectReferences(children, references)
  }

  return references
}

function findReferenceCycle(graph: MailReferenceGraph): readonly string[] | undefined {
  const acyclic = new Set<string>()
  const visit = (key: string, trail: readonly string[]): readonly string[] | undefined => {
    const node = graph.get(key)
    if (!node || acyclic.has(key)) return undefined
    if (trail.includes(key)) return [...trail.slice(trail.indexOf(key)), key]

    for (const reference of collectReferences(node.nodes, new Set())) {
      const cycle = visit(reference, [...trail, key])
      if (cycle) return cycle
    }
    acyclic.add(key)
    return undefined
  }

  for (const key of graph.keys()) {
    const cycle = visit(key, [])
    if (cycle) return cycle
  }
  return undefined
}

const MAIL_TEMPLATE_FORMATS: readonly MailTemplateFormat[] = ['html', 'text']

function componentReferenceGraph(
  components: Readonly<Record<string, CompiledMailComponent>>,
  format: MailTemplateFormat,
): Map<string, MailReferenceNode> {
  return new Map(Object.entries(components).map(([name, component]) => {
    return [componentReferenceKey(name), { name, nodes: component[format] }]
  }))
}

function findFormatReferenceCycle(graphForFormat: (format: MailTemplateFormat) => MailReferenceGraph): {
  readonly graph: MailReferenceGraph
  readonly cycle: readonly string[]
} | undefined {
  for (const format of MAIL_TEMPLATE_FORMATS) {
    const graph = graphForFormat(format)
    const cycle = findReferenceCycle(graph)
    if (cycle) return { graph, cycle }
  }
  return undefined
}

function assertNoComponentCycles(components: Readonly<Record<string, CompiledMailComponent>>): void {
  const found = findFormatReferenceCycle(format => componentReferenceGraph(components, format))
  if (!found) return

  const cycle = found.cycle.map(key => found.graph.get(key)?.name ?? key)
  throw new MailError(
    `[@holo-js/mail] Mail component "${cycle[0]}" creates a component cycle: ${cycle.join(' -> ')}.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

function startCycleAtTemplate(cycle: readonly string[], templates: Readonly<Record<string, ParsedTemplateSyntax>>): readonly string[] {
  const keys = cycle.slice(0, -1)
  const start = keys.findIndex(key => Object.hasOwn(templates, key))
  const rotated = [...keys.slice(start), ...keys.slice(0, start)]
  return [...rotated, ...rotated.slice(0, 1)]
}

function assertNoTemplateComponentCycles(
  templates: Readonly<Record<string, ParsedTemplateSyntax>>,
  components: Readonly<Record<string, CompiledMailComponent>>,
): void {
  const found = findFormatReferenceCycle(format => new Map([
    ...Object.entries(templates).map(([name, template]) => [name, { name, nodes: template.nodes }] as const),
    ...componentReferenceGraph(components, format),
  ]))
  if (!found) return

  const cycle = startCycleAtTemplate(found.cycle, templates)
  throw new MailError(
    `[@holo-js/mail] Mail template "${cycle[0]}" creates a cycle through Mail components: ${cycle.join(' -> ')}.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

function compileMailComponents(
  sources: Readonly<Record<string, MailComponentSource>>,
  templates: ReadonlySet<string>,
): CompiledMailRegistry['components'] {
  const names = { components: new Set(Object.keys(sources)), templates }
  const components = Object.freeze(Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    return [name, compileMailComponent(name, source, names)]
  })))
  assertNoComponentCycles(components)
  return components
}

function compileWithTemplates(
  name: string,
  source: string,
  parsed: Readonly<Record<string, ParsedTemplateSyntax>>,
  components: ReadonlySet<string>,
): CompiledMailTemplate {
  const template = parseTemplateSyntax(name, source, components)
  return Object.freeze({ nodes: template.nodes, data: resolveTemplateData({ ...parsed, [name]: template })(name) })
}

function compileMailLayouts(
  layouts: MailRegistrySources['layouts'] = {},
  parsed: Readonly<Record<string, ParsedTemplateSyntax>>,
  components: ReadonlySet<string>,
): CompiledMailRegistry['layouts'] {
  return Object.freeze({
    ...(typeof layouts.html === 'string' ? { html: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.html, layouts.html, parsed, components) } : {}),
    ...(typeof layouts.text === 'string' ? { text: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.text, layouts.text, parsed, components) } : {}),
  })
}

export const BUILT_IN_COMPILED_MAIL_COMPONENTS: CompiledMailRegistry['components'] = compileMailComponents(DEFAULT_MAIL_SOURCES.components, new Set())

const BUILT_IN_MAIL_COMPONENT_NAMES: ReadonlySet<string> = new Set(Object.keys(BUILT_IN_COMPILED_MAIL_COMPONENTS))

export const BUILT_IN_COMPILED_MAIL_LAYOUTS: Readonly<Record<MailTemplateFormat, CompiledMailTemplate>> = Object.freeze({
  html: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.html, DEFAULT_MAIL_SOURCES.layouts.html, {}, BUILT_IN_MAIL_COMPONENT_NAMES),
  text: compileWithTemplates(MAIL_LAYOUT_FILE_NAMES.text, DEFAULT_MAIL_SOURCES.layouts.text, {}, BUILT_IN_MAIL_COMPONENT_NAMES),
})

export const BUILT_IN_COMPILED_MAIL_TEMPLATES: Readonly<Record<string, CompiledMailTemplate>> = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_MAIL_SOURCES.templates).map(([name, source]) => {
    return [name, compileWithTemplates(name, source, {}, BUILT_IN_MAIL_COMPONENT_NAMES)]
  }),
))

function assertMailTemplateFileName(name: string): void {
  if (isMailTemplateName(name)) return

  throw new MailError(
    `[@holo-js/mail] "${name}" is not a Mail template name. Rename server/mail/templates/${name}.md to use letters, numbers, dashes, and underscores separated by "/", such as "orders/shipped.md".`,
    'MAIL_TEMPLATE_NAME_INVALID',
  )
}

export function compileMailRegistry(sources: MailRegistrySources): CompiledMailRegistry {
  const components = compileMailComponents(
    resolveMailComponentSources(sources.components ?? {}),
    new Set(Object.keys(sources.templates)),
  )
  const componentNames = new Set(Object.keys(components))
  const parsed = Object.fromEntries(Object.entries(sources.templates).map(([name, source]) => {
    assertMailTemplateFileName(name)
    return [name, parseTemplateSyntax(name, source, componentNames)]
  }))
  const templateData = resolveTemplateData(parsed)
  const templates = Object.freeze(Object.fromEntries(Object.entries(parsed).map(([name, template]) => {
    return [name, Object.freeze({ nodes: template.nodes, data: templateData(name) })]
  })))
  assertNoTemplateComponentCycles(parsed, components)

  return Object.freeze({
    templates,
    components,
    layouts: compileMailLayouts(sources.layouts, parsed, componentNames),
    themes: Object.freeze({ ...sources.themes }),
  })
}
