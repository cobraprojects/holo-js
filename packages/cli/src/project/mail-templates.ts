import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { CompiledMailRegistry, MailTemplateDataShape } from '@holo-js/mail/templates'
import { collectFiles } from './discovery-helpers'
import { loadMailTemplatesModule } from './runtime'
import { MAIL_TEMPLATES_ROOT, toPosixPath } from './shared'

const MAIL_TEMPLATE_FILE_PATTERN = /\.md$/

function deriveMailTemplateName(templatesRoot: string, filePath: string): string {
  return toPosixPath(relative(templatesRoot, filePath)).replace(MAIL_TEMPLATE_FILE_PATTERN, '')
}

export async function discoverMailRegistry(projectRoot: string): Promise<CompiledMailRegistry | undefined> {
  const templatesRoot = resolve(projectRoot, MAIL_TEMPLATES_ROOT)
  const files = await collectFiles(templatesRoot, MAIL_TEMPLATE_FILE_PATTERN)
  if (files.length === 0) return undefined

  const entries = await Promise.all(files.map(async filePath => {
    return [deriveMailTemplateName(templatesRoot, filePath), await readFile(filePath, 'utf8')] as const
  }))
  const templates = Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
  const { compileMailRegistry } = await loadMailTemplatesModule(projectRoot)
  return compileMailRegistry({ templates })
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
  return shape.kind === 'value' ? `(${item})` : item
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
