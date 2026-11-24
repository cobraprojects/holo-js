import { resolveMailComponentSources, type MailComponentFiles, type MailComponentSource } from './components'
import { DEFAULT_MAIL_SOURCES } from './defaults'
import { MailError } from './errors'
import { isMailTemplateName } from './template-name'
import { resolveTemplateData, type MailTemplateDataObjectShape } from './template-data'
import {
  childNodeLists,
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

function compileMailComponent(
  name: string,
  source: MailComponentSource,
  components: ReadonlySet<string>,
): CompiledMailComponent {
  return Object.freeze({
    html: parseTemplateSyntax(`components/${name}.html`, source.html, components).nodes,
    text: parseTemplateSyntax(`components/${name}.txt`, source.text, components).nodes,
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

function componentReferenceGraph(components: Readonly<Record<string, CompiledMailComponent>>): Map<string, MailReferenceNode> {
  return new Map(Object.entries(components).map(([name, component]) => {
    return [componentReferenceKey(name), { name, nodes: [...component.html, ...component.text] }]
  }))
}

function assertNoComponentCycles(components: Readonly<Record<string, CompiledMailComponent>>): void {
  const graph = componentReferenceGraph(components)
  const cycle = findReferenceCycle(graph)?.map(key => graph.get(key)?.name ?? key)
  if (!cycle) return

  throw new MailError(
    `[@holo-js/mail] Mail component "${cycle[0]}" creates a component cycle: ${cycle.join(' -> ')}.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

function assertNoTemplateComponentCycles(
  templates: Readonly<Record<string, ParsedTemplateSyntax>>,
  components: Readonly<Record<string, CompiledMailComponent>>,
): void {
  const graph = new Map([
    ...Object.entries(templates).map(([name, template]) => [name, { name, nodes: template.nodes }] as const),
    ...componentReferenceGraph(components),
  ])
  const cycle = findReferenceCycle(graph)
  if (!cycle) return

  throw new MailError(
    `[@holo-js/mail] Mail template "${cycle[0]}" creates a cycle through Mail components: ${cycle.join(' -> ')}.`,
    'MAIL_TEMPLATE_SYNTAX',
  )
}

function compileMailComponents(sources: Readonly<Record<string, MailComponentSource>>): CompiledMailRegistry['components'] {
  const names = new Set(Object.keys(sources))
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

export const BUILT_IN_COMPILED_MAIL_COMPONENTS: CompiledMailRegistry['components'] = compileMailComponents(DEFAULT_MAIL_SOURCES.components)

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
  const components = compileMailComponents(resolveMailComponentSources(sources.components ?? {}))
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
