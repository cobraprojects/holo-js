type Replacement = {
  readonly start: number
  readonly end: number
  readonly text: string
}

type RealtimeDefinitionExport = {
  readonly exportedName: string
  readonly factoryName: 'query' | 'mutation'
  readonly nameValue?: string
}

const serverOnlyRealtimeProperties = new Set(['handler', 'authorize'])

function isIdentifierBoundary(value: string | undefined): boolean {
  return !value || !/[$\w]/.test(value)
}

function skipString(source: string, index: number, quote: string): number {
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === '\\') {
      cursor += 2
      continue
    }

    if (char === quote) {
      return cursor + 1
    }

    cursor += 1
  }

  return cursor
}

function skipLineComment(source: string, index: number): number {
  const end = source.indexOf('\n', index + 2)
  return end === -1 ? source.length : end + 1
}

function skipBlockComment(source: string, index: number): number {
  const end = source.indexOf('*/', index + 2)
  return end === -1 ? source.length : end + 2
}

function skipSyntax(source: string, index: number): number | undefined {
  const char = source[index]
  const next = source[index + 1]

  if (char === '"' || char === '\'' || char === '`') {
    return skipString(source, index, char)
  }

  if (char === '/' && next === '/') {
    return skipLineComment(source, index)
  }

  if (char === '/' && next === '*') {
    return skipBlockComment(source, index)
  }

  return undefined
}

function findRealtimePropertyValueEnd(source: string, index: number): number {
  let cursor = index
  let braceDepth = 0
  let bracketDepth = 0
  let parenDepth = 0

  while (cursor < source.length) {
    const syntaxEnd = skipSyntax(source, cursor)
    if (typeof syntaxEnd === 'number') {
      cursor = syntaxEnd
      continue
    }

    const char = source[cursor]
    if (char === '{') {
      braceDepth += 1
    } else if (char === '}') {
      if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
        return cursor
      }
      braceDepth -= 1
    } else if (char === '[') {
      bracketDepth += 1
    } else if (char === ']') {
      bracketDepth -= 1
    } else if (char === '(') {
      parenDepth += 1
    } else if (char === ')') {
      parenDepth -= 1
    } else if (char === ',' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      return cursor
    }

    cursor += 1
  }

  return source.length
}

function findClosingBrace(source: string, index: number): number {
  let cursor = index
  let depth = 0

  while (cursor < source.length) {
    const syntaxEnd = skipSyntax(source, cursor)
    if (typeof syntaxEnd === 'number') {
      cursor = syntaxEnd
      continue
    }

    const char = source[cursor]
    if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return cursor
      }
    }

    cursor += 1
  }

  return -1
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) {
    return source
  }

  let output = ''
  let cursor = 0
  const ordered = [...replacements].sort((left, right) => left.start - right.start)
  for (const replacement of ordered) {
    output += source.slice(cursor, replacement.start)
    output += replacement.text
    cursor = replacement.end
  }

  return output + source.slice(cursor)
}

function extractObjectPropertyValue(objectSource: string, propertyName: string): string | undefined {
  let cursor = 1
  while (cursor < objectSource.length - 1) {
    const syntaxEnd = skipSyntax(objectSource, cursor)
    if (typeof syntaxEnd === 'number') {
      cursor = syntaxEnd
      continue
    }

    const match = objectSource.slice(cursor).match(/^[$A-Z_a-z][$\w]*/)
    const name = match?.[0]
    if (!name || name !== propertyName) {
      cursor += 1
      continue
    }

    const afterName = cursor + name.length
    if (!isIdentifierBoundary(objectSource[cursor - 1]) || !isIdentifierBoundary(objectSource[afterName])) {
      cursor += name.length
      continue
    }

    let colon = afterName
    while (/\s/.test(objectSource[colon] ?? '')) {
      colon += 1
    }

    if (objectSource[colon] !== ':') {
      cursor += name.length
      continue
    }

    const valueStart = colon + 1
    const valueEnd = findRealtimePropertyValueEnd(objectSource, valueStart)
    return objectSource.slice(valueStart, valueEnd).trim()
  }

  return undefined
}

function collectRealtimeDefinitionExports(source: string): readonly RealtimeDefinitionExport[] {
  const definitions: RealtimeDefinitionExport[] = []
  let cursor = 0

  while (cursor < source.length) {
    const syntaxEnd = skipSyntax(source, cursor)
    if (typeof syntaxEnd === 'number') {
      cursor = syntaxEnd
      continue
    }

    const match = source.slice(cursor).match(/^export\s+const\s+([$A-Z_a-z][$\w]*)\s*=\s*(query|mutation)\s*\(/)
    const exportedName = match?.[1]
    const factoryName = match?.[2] as RealtimeDefinitionExport['factoryName'] | undefined
    if (!exportedName || !factoryName) {
      cursor += 1
      continue
    }

    let objectStart = cursor + match[0].length
    while (/\s/.test(source[objectStart] ?? '')) {
      objectStart += 1
    }

    if (source[objectStart] !== '{') {
      cursor += match[0].length
      continue
    }

    const objectEnd = findClosingBrace(source, objectStart)
    if (objectEnd === -1) {
      cursor += match[0].length
      continue
    }

    const objectSource = source.slice(objectStart, objectEnd + 1)
    definitions.push({
      exportedName,
      factoryName,
      nameValue: extractObjectPropertyValue(objectSource, 'name'),
    })
    cursor = objectEnd + 1
  }

  return definitions
}

export function createRealtimeClientDefinitionModule(source: string): string {
  const definitions = collectRealtimeDefinitionExports(source)
  if (definitions.length === 0) {
    return stripRealtimeServerHandlers(source)
  }

  const factories = [...new Set(definitions.map(definition => definition.factoryName))]
  return [
    `import { ${factories.join(', ')} } from '@holo-js/adapter-nuxt/realtime'`,
    '',
    ...definitions.flatMap((definition) => [
      `export const ${definition.exportedName} = ${definition.factoryName}({`,
      ...(definition.nameValue ? [`  name: ${definition.nameValue},`] : []),
      '  handler: undefined,',
      '})',
      '',
    ]),
  ].join('\n')
}

export function stripRealtimeServerHandlers(source: string): string {
  const replacements: Replacement[] = []
  let cursor = 0

  while (cursor < source.length) {
    const syntaxEnd = skipSyntax(source, cursor)
    if (typeof syntaxEnd === 'number') {
      cursor = syntaxEnd
      continue
    }

    const match = source.slice(cursor).match(/^[$A-Z_a-z][$\w]*/)
    const name = match?.[0]
    if (!name || !serverOnlyRealtimeProperties.has(name)) {
      cursor += 1
      continue
    }

    const afterName = cursor + name.length
    if (!isIdentifierBoundary(source[cursor - 1]) || !isIdentifierBoundary(source[afterName])) {
      cursor += name.length
      continue
    }

    let colon = afterName
    while (/\s/.test(source[colon] ?? '')) {
      colon += 1
    }

    if (source[colon] !== ':') {
      cursor += name.length
      continue
    }

    const valueStart = colon + 1
    const valueEnd = findRealtimePropertyValueEnd(source, valueStart)
    replacements.push({
      start: valueStart,
      end: valueEnd,
      text: ' undefined',
    })
    cursor = valueEnd
  }

  return applyReplacements(source, replacements)
}
