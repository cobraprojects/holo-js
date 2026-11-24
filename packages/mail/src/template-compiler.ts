import { resolveMailComponentSources, type MailComponentFiles, type MailComponentSource } from './components'
import { DEFAULT_MAIL_SOURCES } from './defaults'
import { MailError } from './errors'
import {
  collectTemplateData,
  resolveTemplateData,
  type MailTemplateDataObjectShape,
  type ParsedMailTemplate,
} from './template-data'
import {
  childNodeLists,
  parseTemplateSyntax,
  type MailTemplateFormat,
  type MailTemplateNode,
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

function parseMailTemplate(template: string, source: string, components: ReadonlySet<string>): ParsedMailTemplate {
  return collectTemplateData(template, parseTemplateSyntax(template, source, components))
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

function collectComponentReferences(nodes: readonly MailTemplateNode[], references: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.type === 'component') references.add(node.name)
    for (const children of childNodeLists(node)) collectComponentReferences(children, references)
  }

  return references
}

function assertNoComponentCycles(components: Readonly<Record<string, CompiledMailComponent>>): void {
  const acyclic = new Set<string>()
  const visit = (name: string, trail: readonly string[]): void => {
    if (acyclic.has(name)) return
    if (trail.includes(name)) {
      const cycle = [...trail.slice(trail.indexOf(name)), name]
      throw new MailError(
        `[@holo-js/mail] Mail component "${cycle[0]}" creates a component cycle: ${cycle.join(' -> ')}.`,
        'MAIL_TEMPLATE_SYNTAX',
      )
    }

    const component = components[name]
    const references = component ? collectComponentReferences([...component.html, ...component.text], new Set()) : new Set<string>()
    for (const reference of references) visit(reference, [...trail, name])
    acyclic.add(name)
  }

  for (const name of Object.keys(components)) visit(name, [])
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
  parsed: Readonly<Record<string, ParsedMailTemplate>>,
  components: ReadonlySet<string>,
): CompiledMailTemplate {
  const template = parseMailTemplate(name, source, components)
  return Object.freeze({ nodes: template.nodes, data: resolveTemplateData(name, { ...parsed, [name]: template }) })
}

function compileMailLayouts(
  layouts: MailRegistrySources['layouts'] = {},
  parsed: Readonly<Record<string, ParsedMailTemplate>>,
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

export function compileMailRegistry(sources: MailRegistrySources): CompiledMailRegistry {
  const components = compileMailComponents(resolveMailComponentSources(sources.components ?? {}))
  const componentNames = new Set(Object.keys(components))
  const parsed = Object.fromEntries(Object.entries(sources.templates).map(([name, source]) => {
    return [name, parseMailTemplate(name, source, componentNames)]
  }))

  return Object.freeze({
    templates: Object.freeze(Object.fromEntries(Object.entries(parsed).map(([name, template]) => {
      return [name, Object.freeze({ nodes: template.nodes, data: resolveTemplateData(name, parsed) })]
    }))),
    components,
    layouts: compileMailLayouts(sources.layouts, parsed, componentNames),
    themes: Object.freeze({ ...sources.themes }),
  })
}
