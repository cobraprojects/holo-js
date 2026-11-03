export type SqlTokenKind = 'word' | 'quotedIdentifier' | 'string' | 'literal' | 'group' | 'symbol'

export interface SqlToken {
  readonly kind: SqlTokenKind
  readonly start: number
  readonly end: number
  readonly keyword?: string
  readonly value?: string
  readonly children?: readonly SqlToken[]
}

const IDENTIFIER_QUOTES: Readonly<Record<string, string>> = { '"': '"', '`': '`', '[': ']' }
const WORD_START_PATTERN = /[\p{L}_]/u
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_$]/u
const LITERAL_PATTERN = /x'[\da-f]*'|0x[\da-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iy

interface LexResult {
  readonly tokens: SqlToken[]
  readonly end: number
}

function quotedEnd(sql: string, start: number, closingQuote: string): number {
  for (let index = sql.indexOf(closingQuote, start + 1); index !== -1; index = sql.indexOf(closingQuote, index + 2)) {
    if (closingQuote === ']' || sql.charAt(index + 1) !== closingQuote) return index + 1
  }
  return sql.length
}

function decodeQuoted(text: string, closingQuote: string): string {
  const inner = text.slice(1, -1)
  return closingQuote === ']' ? inner : inner.replaceAll(closingQuote.repeat(2), closingQuote)
}

function skippedEnd(sql: string, index: number): number | undefined {
  if (/\s/.test(sql.charAt(index))) return index + 1
  const opener = sql.slice(index, index + 2)
  if (opener === '--') {
    const lineEnd = sql.indexOf('\n', index)
    return lineEnd === -1 ? sql.length : lineEnd
  }
  if (opener === '/*') {
    const blockEnd = sql.indexOf('*/', index + 2)
    return blockEnd === -1 ? sql.length : blockEnd + 2
  }
  return undefined
}

function wordEnd(sql: string, start: number): number {
  let end = start + 1
  while (end < sql.length && WORD_CHARACTER_PATTERN.test(sql.charAt(end))) end += 1
  return end
}

function literalEnd(sql: string, start: number): number | undefined {
  LITERAL_PATTERN.lastIndex = start
  return LITERAL_PATTERN.test(sql) ? LITERAL_PATTERN.lastIndex : undefined
}

function readToken(sql: string, start: number): SqlToken {
  const character = sql.charAt(start)
  const identifierQuote = IDENTIFIER_QUOTES[character]
  if (identifierQuote) {
    const end = quotedEnd(sql, start, identifierQuote)
    return { kind: 'quotedIdentifier', start, end, value: decodeQuoted(sql.slice(start, end), identifierQuote) }
  }
  if (character === '\'') {
    const end = quotedEnd(sql, start, '\'')
    return { kind: 'string', start, end, value: decodeQuoted(sql.slice(start, end), '\'') }
  }
  const literalTokenEnd = literalEnd(sql, start)
  if (literalTokenEnd !== undefined) return { kind: 'literal', start, end: literalTokenEnd }
  if (WORD_START_PATTERN.test(character)) {
    const end = wordEnd(sql, start)
    const value = sql.slice(start, end)
    return { kind: 'word', start, end, keyword: value.toUpperCase(), value }
  }
  if (character === '(') {
    const inner = lex(sql, start + 1, ')')
    return { kind: 'group', start, end: Math.min(inner.end + 1, sql.length), children: inner.tokens }
  }
  return { kind: 'symbol', start, end: start + 1, value: character }
}

function lex(sql: string, start: number, terminator?: string): LexResult {
  const tokens: SqlToken[] = []
  let index = start
  while (index < sql.length && sql.charAt(index) !== terminator) {
    const skipped = skippedEnd(sql, index)
    if (skipped !== undefined) {
      index = skipped
      continue
    }
    const token = readToken(sql, index)
    tokens.push(token)
    index = token.end
  }
  return { tokens, end: index }
}

export function tokenizeSql(sql: string): SqlToken[] {
  return lex(sql, 0).tokens
}

export function readNameToken(token: SqlToken | undefined): string | undefined {
  return token?.kind === 'word' || token?.kind === 'quotedIdentifier' || token?.kind === 'string' ? token.value : undefined
}

export function splitTokensOnCommas(tokens: readonly SqlToken[]): SqlToken[][] {
  const items: SqlToken[][] = [[]]
  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === ',') items.push([])
    else items[items.length - 1]?.push(token)
  }
  return items.filter(item => item.length > 0)
}

export function sliceTokens(sql: string, tokens: readonly SqlToken[]): string {
  const first = tokens[0]
  const last = tokens[tokens.length - 1]
  return first && last ? sql.slice(first.start, last.end) : ''
}
