const IDENTIFIER_PATTERN = '"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Z_]\\w*'
const STRING_LITERAL_PATTERN = '\'(?:[^\']|\'\')*\''

const QUOTE_PAIRS: Readonly<Record<string, string>> = { '\'': '\'', '"': '"', '`': '`', '[': ']' }

function unquoteIdentifier(identifier: string): string {
  const first = identifier[0]
  if (first === '"') return identifier.slice(1, -1).replaceAll('""', '"')
  if (first === '`') return identifier.slice(1, -1).replaceAll('``', '`')
  if (first === '[') return identifier.slice(1, -1)
  return identifier
}

export function unquoteStringLiteral(literal: string): string {
  return literal.slice(1, -1).replaceAll('\'\'', '\'')
}

export function readStringLiterals(text: string): string[] {
  return [...text.matchAll(new RegExp(STRING_LITERAL_PATTERN, 'g'))].map(match => unquoteStringLiteral(match[0]))
}

function findClosingParenthesis(sql: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < sql.length; index += 1) {
    const character = sql[index]!
    const closingQuote = QUOTE_PAIRS[character]
    if (closingQuote) {
      index = sql.indexOf(closingQuote, index + 1)
      if (index === -1) return -1
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

export function splitTableDefinitions(createTableSql: string): string[] {
  const openIndex = createTableSql.indexOf('(')
  const closeIndex = openIndex === -1 ? -1 : findClosingParenthesis(createTableSql, openIndex)
  if (closeIndex === -1) return []

  const body = createTableSql.slice(openIndex + 1, closeIndex)
  const definitions: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!
    const closingQuote = QUOTE_PAIRS[character]
    if (closingQuote) {
      index = body.indexOf(closingQuote, index + 1)
      if (index === -1) break
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      definitions.push(body.slice(start, index).trim())
      start = index + 1
    }
  }
  definitions.push(body.slice(start).trim())
  return definitions.filter(definition => definition.length > 0)
}

const TABLE_CONSTRAINT_PATTERN = /^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i
const LEADING_IDENTIFIER_PATTERN = new RegExp(`^(${IDENTIFIER_PATTERN})`, 'i')

export function readColumnDefinitionName(definition: string): string | undefined {
  if (TABLE_CONSTRAINT_PATTERN.test(definition)) return undefined
  const match = definition.match(LEADING_IDENTIFIER_PATTERN)
  return match ? unquoteIdentifier(match[1]!) : undefined
}

const ENUM_CHECK_PATTERN = new RegExp(
  `(?:CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+)?CHECK\\s*\\(\\s*(${IDENTIFIER_PATTERN})\\s+IN\\s*\\(\\s*(${STRING_LITERAL_PATTERN}(?:\\s*,\\s*${STRING_LITERAL_PATTERN})*)\\s*\\)\\s*\\)`,
  'gi',
)

export function readEnumChecks(definition: string): { name?: string, column: string, values: string[] }[] {
  return [...definition.matchAll(ENUM_CHECK_PATTERN)].map(match => ({
    ...(match[1] ? { name: unquoteIdentifier(match[1]) } : {}),
    column: unquoteIdentifier(match[2]!),
    values: readStringLiterals(match[3]!),
  }))
}

const INLINE_FOREIGN_KEY_NAME_PATTERN = new RegExp(`CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+REFERENCES\\b`, 'i')
const TABLE_FOREIGN_KEY_PATTERN = new RegExp(
  `^(?:CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+)?FOREIGN\\s+KEY\\s*\\(\\s*(${IDENTIFIER_PATTERN})\\s*\\)`,
  'i',
)

export function readForeignKeyName(definition: string, columnName: string | undefined): { column: string, name: string } | undefined {
  if (columnName) {
    const inline = definition.match(INLINE_FOREIGN_KEY_NAME_PATTERN)
    return inline ? { column: columnName, name: unquoteIdentifier(inline[1]!) } : undefined
  }

  const tableLevel = definition.match(TABLE_FOREIGN_KEY_PATTERN)
  return tableLevel?.[1] ? { column: unquoteIdentifier(tableLevel[2]!), name: unquoteIdentifier(tableLevel[1]) } : undefined
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}
