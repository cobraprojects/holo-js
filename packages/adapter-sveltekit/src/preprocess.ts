import {
  type Replacement,
  applyReplacements,
  skipBlockComment,
  skipLineComment,
  skipString,
} from './transform-utils'

type MarkupInput = {
  readonly content: string
  readonly filename?: string
}

type MarkupOutput = {
  readonly code: string
}

type SveltePreprocessor = {
  readonly name?: string
  markup(input: MarkupInput): MarkupOutput
}

type ScriptBlock = {
  readonly contentStart: number
  readonly contentEnd: number
  readonly content: string
}

const clientImportPattern = /import\s*\{([^}]*)\}\s*from\s*['"]@holo-js\/adapter-sveltekit\/client['"]/g
const identifier = String.raw`[$A-Z_a-z][$\w]*`
export const HOLO_SVELTE_PREPROCESS_NAME = 'holo-sveltekit'

function collectUseFormAliases(script: string): readonly string[] {
  const aliases = new Set<string>()
  for (const match of script.matchAll(clientImportPattern)) {
    const imports = match[1] as string
    for (const rawSpecifier of imports.split(',')) {
      const specifier = rawSpecifier.trim()
      const aliased = specifier.match(new RegExp(String.raw`^useForm\s+as\s+(${identifier})$`))
      if (specifier === 'useForm') {
        aliases.add('useForm')
      } else if (aliased?.[1]) {
        aliases.add(aliased[1])
      }
    }
  }

  return [...aliases]
}

function collectScriptBlocks(content: string): readonly ScriptBlock[] {
  const blocks: ScriptBlock[] = []
  const pattern = /<script\b[^>]*>/g
  for (const match of content.matchAll(pattern)) {
    const contentStart = match.index + match[0].length
    const closeIndex = content.indexOf('</script>', contentStart)
    if (closeIndex === -1) {
      continue
    }

    blocks.push({
      contentStart,
      contentEnd: closeIndex,
      content: content.slice(contentStart, closeIndex),
    })
  }

  return blocks
}

function skipTypeArguments(source: string, index: number): number {
  if (source[index] !== '<') {
    return index
  }

  let depth = 0
  let cursor = index
  while (cursor < source.length) {
    const char = source[cursor]
    const next = source[cursor + 1]
    if (char === '"' || char === '\'' || char === '`') {
      cursor = skipString(source, cursor, char)
      continue
    }

    if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor)
      continue
    }

    if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor)
      continue
    }

    if (char === '<') {
      depth += 1
    } else if (char === '>') {
      depth -= 1
      if (depth === 0) {
        return cursor + 1
      }
    }

    cursor += 1
  }

  return index
}

function findOpeningParen(source: string, index: number): number {
  let cursor = index
  while (/\s/.test(source[cursor] ?? '')) {
    cursor += 1
  }

  cursor = skipTypeArguments(source, cursor)
  while (/\s/.test(source[cursor] ?? '')) {
    cursor += 1
  }

  return source[cursor] === '(' ? cursor : -1
}

function findClosingParen(source: string, index: number): number {
  let depth = 0
  let cursor = index
  while (cursor < source.length) {
    const char = source[cursor]
    const next = source[cursor + 1]
    if (char === '"' || char === '\'' || char === '`') {
      cursor = skipString(source, cursor, char)
      continue
    }

    if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor)
      continue
    }

    if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor)
      continue
    }

    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }

    cursor += 1
  }

  return -1
}

function transformScript(script: string): string {
  const aliases = collectUseFormAliases(script)
  if (aliases.length === 0) {
    return script
  }

  const aliasPattern = aliases.map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const declarationPattern = new RegExp(
    String.raw`(^|\n)([ \t]*)const\s+(${identifier})\s*=\s*(${aliasPattern})\b`,
    'g',
  )
  const replacements: Replacement[] = []

  for (const match of script.matchAll(declarationPattern)) {
    const indentation = match[2] as string
    const variable = match[3]
    if (!variable || script.includes(`${variable}.subscribe(() => { ${variable} = ${variable} })`)) {
      continue
    }

    const constStart = match.index + (match[1] as string).length + indentation.length
    const calleeEnd = match.index + match[0].length
    const openingParen = findOpeningParen(script, calleeEnd)
    if (openingParen === -1) {
      continue
    }

    const closingParen = findClosingParen(script, openingParen)
    if (closingParen === -1) {
      continue
    }

    replacements.push({
      start: constStart,
      end: constStart + 'const'.length,
      text: 'let',
    }, {
      start: closingParen + 1,
      end: closingParen + 1,
      text: `\n${indentation}${variable}.subscribe(() => { ${variable} = ${variable} })`,
    })
  }

  return applyReplacements(script, replacements)
}

export function transformSvelteUseFormReactivity(content: string): string {
  const replacements = collectScriptBlocks(content).flatMap((block) => {
    const transformed = transformScript(block.content)
    return transformed === block.content
      ? []
      : [{
          start: block.contentStart,
          end: block.contentEnd,
          text: transformed,
        }]
  })

  return applyReplacements(content, replacements)
}

export function holoSveltePreprocess(): SveltePreprocessor {
  return {
    name: HOLO_SVELTE_PREPROCESS_NAME,
    markup({ content }) {
      return {
        code: transformSvelteUseFormReactivity(content),
      }
    },
  }
}

export const sveltePreprocessInternals = {
  collectScriptBlocks,
  collectUseFormAliases,
  findClosingParen,
  findOpeningParen,
  skipTypeArguments,
  transformScript,
}
