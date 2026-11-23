import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { CompiledMailRegistry, MailTemplateDataShape } from '@holo-js/mail/templates'
import { collectFiles } from './discovery-helpers'
import { loadMailTemplatesModule } from './runtime'
import { MAIL_ROOT, MAIL_TEMPLATES_ROOT, MAIL_THEMES_ROOT, pathExists, toPosixPath } from './shared'

const MAIL_TEMPLATE_FILE_PATTERN = /\.md$/
const MAIL_THEME_FILE_PATTERN = /\.css$/

async function readNamedFiles(root: string, pattern: RegExp): Promise<Record<string, string>> {
  const files = await collectFiles(root, pattern)
  const entries = await Promise.all(files.map(async filePath => {
    return [toPosixPath(relative(root, filePath)).replace(pattern, ''), await readFile(filePath, 'utf8')] as const
  }))
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)))
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  return await pathExists(filePath) ? await readFile(filePath, 'utf8') : undefined
}

export async function discoverMailRegistry(projectRoot: string): Promise<CompiledMailRegistry | undefined> {
  const templates = await readNamedFiles(resolve(projectRoot, MAIL_TEMPLATES_ROOT), MAIL_TEMPLATE_FILE_PATTERN)
  const themes = await readNamedFiles(resolve(projectRoot, MAIL_THEMES_ROOT), MAIL_THEME_FILE_PATTERN)
  const html = await readOptionalFile(resolve(projectRoot, MAIL_ROOT, 'layout.html'))
  const text = await readOptionalFile(resolve(projectRoot, MAIL_ROOT, 'layout.txt'))
  const layouts = {
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof text === 'string' ? { text } : {}),
  }
  if ([templates, themes, layouts].every(section => Object.keys(section).length === 0)) return undefined

  const { compileMailRegistry } = await loadMailTemplatesModule(projectRoot)
  return compileMailRegistry({ templates, layouts, themes })
}

export function renderMailTemplateDataType(shape: MailTemplateDataShape): string {
  if (shape.kind === 'value') return 'string | number'
  const properties = Object.entries(shape.properties)
  if (properties.length === 0) return 'Record<string, never>'
  return `{ ${properties.map(([name, property]) => `readonly ${name}: ${renderMailTemplateDataType(property)}`).join(', ')} }`
}
