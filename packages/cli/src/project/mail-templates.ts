import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { CompiledMailRegistry, MailRegistrySources, MailTemplateDataShape, MailTemplateFormat } from '@holo-js/mail/templates'
import { collectFiles } from './discovery-helpers'
import { loadMailTemplatesModule } from './runtime'
import { MAIL_COMPONENTS_ROOT, MAIL_ROOT, MAIL_TEMPLATES_ROOT, MAIL_THEMES_ROOT, toPosixPath } from './shared'

const MAIL_TEMPLATE_FILE_PATTERN = /\.md$/
const MAIL_THEME_FILE_PATTERN = /\.css$/
const MAIL_COMPONENT_HTML_FILE_PATTERN = /\.html$/
const MAIL_COMPONENT_TEXT_FILE_PATTERN = /\.txt$/
export const MAIL_SOURCE_FILE_PATTERN = /\.(?:md|css|html|txt)$/
const MAIL_LAYOUT_FILES: Readonly<Record<MailTemplateFormat, string>> = {
  html: `${MAIL_ROOT}/layout.html`,
  text: `${MAIL_ROOT}/layout.txt`,
}

export interface PublishableFile {
  readonly path: string
  readonly contents: string
}

export type MailSourceSnapshot = ReadonlyMap<string, Buffer>

export async function readMailSourceSnapshot(projectRoot: string): Promise<MailSourceSnapshot> {
  const files = await collectFiles(resolve(projectRoot, MAIL_ROOT), MAIL_SOURCE_FILE_PATTERN)
  return new Map(await Promise.all(files.sort().map(async filePath => [filePath, await readFile(filePath)] as const)))
}

function namedSources(snapshot: MailSourceSnapshot, root: string, pattern: RegExp): Record<string, string> {
  const entries = [...snapshot].flatMap(([filePath, contents]) => {
    const relativePath = toPosixPath(relative(root, filePath))
    if (relativePath.startsWith('../') || !pattern.test(relativePath)) return []
    return [[relativePath.replace(pattern, ''), contents.toString('utf8')] as const]
  })
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

function mailComponentSources(snapshot: MailSourceSnapshot, root: string): NonNullable<MailRegistrySources['components']> {
  const html = namedSources(snapshot, root, MAIL_COMPONENT_HTML_FILE_PATTERN)
  const text = namedSources(snapshot, root, MAIL_COMPONENT_TEXT_FILE_PATTERN)
  const names = [...new Set([...Object.keys(html), ...Object.keys(text)])].sort()
  return Object.fromEntries(names.map(name => [name, {
    ...(Object.hasOwn(html, name) ? { html: html[name] } : {}),
    ...(Object.hasOwn(text, name) ? { text: text[name] } : {}),
  }]))
}

export async function discoverMailRegistry(
  projectRoot: string,
  snapshot: MailSourceSnapshot,
): Promise<CompiledMailRegistry | undefined> {
  const templates = namedSources(snapshot, resolve(projectRoot, MAIL_TEMPLATES_ROOT), MAIL_TEMPLATE_FILE_PATTERN)
  const themes = namedSources(snapshot, resolve(projectRoot, MAIL_THEMES_ROOT), MAIL_THEME_FILE_PATTERN)
  const components = mailComponentSources(snapshot, resolve(projectRoot, MAIL_COMPONENTS_ROOT))
  const html = snapshot.get(resolve(projectRoot, MAIL_LAYOUT_FILES.html))?.toString('utf8')
  const text = snapshot.get(resolve(projectRoot, MAIL_LAYOUT_FILES.text))?.toString('utf8')
  const layouts = {
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof text === 'string' ? { text } : {}),
  }
  if ([templates, themes, layouts, components].every(section => Object.keys(section).length === 0)) return undefined

  const { compileMailRegistry } = await loadMailTemplatesModule(projectRoot)
  return compileMailRegistry({ templates, components, layouts, themes })
}

export async function loadPublishableMailFiles(projectRoot: string): Promise<readonly PublishableFile[]> {
  const { DEFAULT_MAIL_SOURCES: sources } = await loadMailTemplatesModule(projectRoot)
  return [
    { path: MAIL_LAYOUT_FILES.html, contents: sources.layouts.html },
    { path: MAIL_LAYOUT_FILES.text, contents: sources.layouts.text },
    ...Object.entries(sources.components).flatMap(([name, component]) => [
      { path: `${MAIL_COMPONENTS_ROOT}/${name}.html`, contents: component.html },
      { path: `${MAIL_COMPONENTS_ROOT}/${name}.txt`, contents: component.text },
    ]),
    ...Object.entries(sources.themes).map(([name, css]) => ({ path: `${MAIL_THEMES_ROOT}/${name}.css`, contents: css })),
    ...Object.entries(sources.templates).map(([name, source]) => ({ path: `${MAIL_TEMPLATES_ROOT}/${name}.md`, contents: source })),
  ]
}

function isOptionalShape(shape: MailTemplateDataShape): boolean {
  if (shape.kind === 'json') return true
  if (shape.kind !== 'object') return false
  const properties = Object.values(shape.properties)
  return properties.length > 0 && properties.every(isOptionalShape)
}

export function usesMailJsonValue(shape: MailTemplateDataShape): boolean {
  if (shape.kind === 'json') return true
  if (shape.kind === 'list') return usesMailJsonValue(shape.item)
  return shape.kind === 'object' && Object.values(shape.properties).some(usesMailJsonValue)
}

function renderListItemType(shape: MailTemplateDataShape): string {
  const item = renderMailTemplateDataType(shape)
  return shape.kind === 'value' || shape.kind === 'list' ? `(${item})` : item
}

export function renderMailTemplateDataType(shape: MailTemplateDataShape): string {
  if (shape.kind === 'value') return 'string | number'
  if (shape.kind === 'json') return 'MailJsonValue'
  if (shape.kind === 'list') return `readonly ${renderListItemType(shape.item)}[]`
  const properties = Object.entries(shape.properties)
  if (properties.length === 0) return 'Record<string, never>'
  return `{ ${properties.map(([name, property]) => {
    return `readonly ${name}${isOptionalShape(property) ? '?' : ''}: ${renderMailTemplateDataType(property)}`
  }).join(', ')} }`
}
