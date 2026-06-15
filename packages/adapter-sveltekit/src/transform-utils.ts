export type Replacement = {
  readonly start: number
  readonly end: number
  readonly text: string
}

export function skipString(source: string, index: number, quote: string): number {
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

export function skipLineComment(source: string, index: number): number {
  const end = source.indexOf('\n', index + 2)
  return end === -1 ? source.length : end + 1
}

export function skipBlockComment(source: string, index: number): number {
  const end = source.indexOf('*/', index + 2)
  return end === -1 ? source.length : end + 2
}

export function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  if (replacements.length === 0) {
    return source
  }

  let output = ''
  let cursor = 0
  const orderedReplacements = [...replacements].sort((left, right) => left.start - right.start)
  for (const replacement of orderedReplacements) {
    output += source.slice(cursor, replacement.start)
    output += replacement.text
    cursor = replacement.end
  }

  return output + source.slice(cursor)
}
