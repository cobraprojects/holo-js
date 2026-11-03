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

export interface CreateTableSqlParts {
  readonly definitions: string[]
  readonly options: string
}

export function splitCreateTableSql(createTableSql: string): CreateTableSqlParts | undefined {
  const openIndex = createTableSql.indexOf('(')
  const closeIndex = openIndex === -1 ? -1 : findClosingParenthesis(createTableSql, openIndex)
  if (closeIndex === -1) return undefined

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
  return {
    definitions: definitions.filter(definition => definition.length > 0),
    options: createTableSql.slice(closeIndex + 1).trim(),
  }
}

export function splitTableDefinitions(createTableSql: string): string[] {
  return splitCreateTableSql(createTableSql)?.definitions ?? []
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

export interface ForeignKeyDefinition {
  readonly column: string
  readonly name?: string
}

export function readForeignKey(definition: string, columnName: string | undefined): ForeignKeyDefinition | undefined {
  if (columnName) {
    if (!readInlineColumnConstraints(definition).references) return undefined
    const inline = definition.match(INLINE_FOREIGN_KEY_NAME_PATTERN)
    return inline ? { column: columnName, name: unquoteIdentifier(inline[1]!) } : { column: columnName }
  }

  const tableLevel = definition.match(TABLE_FOREIGN_KEY_PATTERN)
  if (!tableLevel) return undefined
  const column = unquoteIdentifier(tableLevel[2]!)
  return tableLevel[1] ? { column, name: unquoteIdentifier(tableLevel[1]) } : { column }
}

const IDENTIFIER = `(?:${IDENTIFIER_PATTERN})`
const REFERENCES_CLAUSE_PATTERN = new RegExp(
  `\\s+(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?REFERENCES\\s+${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?(?:\\s*\\(\\s*${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*\\s*\\))?`
  + '(?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT|NO\\s+ACTION)|\\s+MATCH\\s+\\w+|\\s+(?:NOT\\s+)?DEFERRABLE(?:\\s+INITIALLY\\s+(?:DEFERRED|IMMEDIATE))?)*',
  'gi',
)
const INLINE_UNIQUE_PATTERN = new RegExp(
  `\\s+(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?UNIQUE(?:\\s+ON\\s+CONFLICT\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?\\b`,
  'gi',
)
const TABLE_UNIQUE_PATTERN = new RegExp(`^(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?UNIQUE\\s*\\(([^)]*)\\)`, 'i')

function removeKeywordClause(definition: string, pattern: RegExp): string | undefined {
  const masked = maskQuotedText(definition)
  for (const match of definition.matchAll(pattern)) {
    const keywordIndex = match.index + match[0].search(/\S/)
    if (masked[keywordIndex] !== ' ') {
      return definition.slice(0, match.index) + definition.slice(match.index + match[0].length)
    }
  }
  return undefined
}

function readTableUniqueColumns(definition: string): string[] | undefined {
  const match = definition.match(TABLE_UNIQUE_PATTERN)
  return match?.[1]?.split(',').map(column => readColumnDefinitionName(column.trim()) ?? column.trim())
}

function removeDefinitions(
  definitions: readonly string[],
  rewrite: (definition: string, columnName: string | undefined) => string | null | undefined,
): string[] | undefined {
  let removed = false
  const kept: string[] = []
  for (const definition of definitions) {
    const rewritten = rewrite(definition, readColumnDefinitionName(definition))
    if (rewritten === undefined) {
      kept.push(definition)
      continue
    }
    removed = true
    if (rewritten !== null) kept.push(rewritten)
  }
  return removed ? kept : undefined
}

export function removeForeignKeyDefinitions(
  definitions: readonly string[],
  matches: (foreignKey: ForeignKeyDefinition) => boolean,
): string[] | undefined {
  return removeDefinitions(definitions, (definition, columnName) => {
    const foreignKey = readForeignKey(definition, columnName)
    if (!foreignKey || !matches(foreignKey)) return undefined
    return columnName ? removeKeywordClause(definition, REFERENCES_CLAUSE_PATTERN) : null
  })
}

export function removeUniqueDefinitions(definitions: readonly string[], columns: readonly string[]): string[] | undefined {
  return removeDefinitions(definitions, (definition, columnName) => {
    if (columnName) {
      return columns.length === 1 && columns[0] === columnName && readInlineColumnConstraints(definition).unique
        ? removeKeywordClause(definition, INLINE_UNIQUE_PATTERN)
        : undefined
    }
    return readTableUniqueColumns(definition)?.join('\0') === columns.join('\0') ? null : undefined
  })
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}

const QUOTED_TEXT_PATTERN = new RegExp(`${STRING_LITERAL_PATTERN}|"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\\[[^\\]]*\\]`, 'g')

export interface InlineColumnConstraints {
  readonly primaryKey: boolean
  readonly autoIncrement: boolean
  readonly unique: boolean
  readonly references: boolean
}

function maskQuotedText(text: string): string {
  return text.replace(QUOTED_TEXT_PATTERN, quoted => ' '.repeat(quoted.length))
}

export function readInlineColumnConstraints(definition: string): InlineColumnConstraints {
  const keywords = maskQuotedText(definition)
  return {
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(keywords),
    autoIncrement: /\bAUTOINCREMENT\b/i.test(keywords),
    unique: /\bUNIQUE\b/i.test(keywords),
    references: /\bREFERENCES\b/i.test(keywords),
  }
}
