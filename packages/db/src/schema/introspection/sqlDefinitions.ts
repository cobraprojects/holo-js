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

type UnquotedCharacterVisitor = (character: string, index: number, depth: number) => boolean

function findUnquotedCharacter(sql: string, startIndex: number, matches: UnquotedCharacterVisitor): number {
  let depth = 0
  for (let index = startIndex; index < sql.length; index += 1) {
    const character = sql.charAt(index)
    const closingQuote = QUOTE_PAIRS[character]
    if (closingQuote) {
      index = sql.indexOf(closingQuote, index + 1)
      if (index === -1) return -1
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (matches(character, index, depth)) return index
  }
  return -1
}

export function findClosingParenthesis(sql: string, openIndex: number): number {
  return findUnquotedCharacter(sql, openIndex, (character, _index, depth) => character === ')' && depth === 0)
}

function splitTopLevelCommas(sql: string): string[] {
  const separators: number[] = []
  findUnquotedCharacter(sql, 0, (character, index, depth) => {
    if (character === ',' && depth === 0) separators.push(index)
    return false
  })
  const starts = [0, ...separators.map(separator => separator + 1)]
  return starts.map((start, position) => sql.slice(start, separators[position] ?? sql.length).trim())
}

export interface CreateTableSqlParts {
  readonly definitions: string[]
  readonly options: string
}

function commentEnd(sql: string, index: number): number | undefined {
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

function withoutSqlComments(sql: string): string {
  let result = ''
  for (let index = 0; index < sql.length;) {
    const closingQuote = QUOTE_PAIRS[sql.charAt(index)]
    if (closingQuote) {
      const quoteEnd = sql.indexOf(closingQuote, index + 1)
      const end = quoteEnd === -1 ? sql.length : quoteEnd + 1
      result += sql.slice(index, end)
      index = end
      continue
    }
    const end = commentEnd(sql, index)
    if (end !== undefined) {
      result += ' '
      index = end
      continue
    }
    result += sql.charAt(index)
    index += 1
  }
  return result
}

export function splitCreateTableSql(storedCreateTableSql: string): CreateTableSqlParts | undefined {
  const createTableSql = withoutSqlComments(storedCreateTableSql)
  const openIndex = createTableSql.indexOf('(')
  const closeIndex = openIndex === -1 ? -1 : findClosingParenthesis(createTableSql, openIndex)
  if (closeIndex === -1) return undefined

  const definitions = splitTopLevelCommas(createTableSql.slice(openIndex + 1, closeIndex))
  return {
    definitions: definitions.filter(definition => definition.length > 0),
    options: createTableSql.slice(closeIndex + 1).trim(),
  }
}

export function splitTableDefinitions(createTableSql: string): string[] {
  return splitCreateTableSql(createTableSql)?.definitions ?? []
}

const CREATE_INDEX_NAME_PATTERN = new RegExp(`^(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+)(?:${IDENTIFIER_PATTERN})`, 'i')

export function withIndexName(createIndexSql: string, quotedIndexName: string): string | undefined {
  if (!CREATE_INDEX_NAME_PATTERN.test(createIndexSql)) return undefined
  return createIndexSql.replace(CREATE_INDEX_NAME_PATTERN, (_match, prefix: string) => `${prefix}${quotedIndexName}`)
}

const PRIMARY_KEY_CONSTRAINT_PATTERN = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i
const TABLE_CONSTRAINT_PATTERN = /^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i
const LEADING_IDENTIFIER_PATTERN = new RegExp(`^(${IDENTIFIER_PATTERN})`, 'i')

export function isPrimaryKeyConstraintDefinition(definition: string): boolean {
  return PRIMARY_KEY_CONSTRAINT_PATTERN.test(definition)
}

export function readColumnDefinitionName(definition: string): string | undefined {
  if (TABLE_CONSTRAINT_PATTERN.test(definition)) return undefined
  const name = definition.match(LEADING_IDENTIFIER_PATTERN)?.[1]
  return name === undefined ? undefined : unquoteIdentifier(name)
}

const ENUM_CHECK_PATTERN = new RegExp(
  `(?:CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+)?CHECK\\s*\\(\\s*(${IDENTIFIER_PATTERN})\\s+IN\\s*\\(\\s*(${STRING_LITERAL_PATTERN}(?:\\s*,\\s*${STRING_LITERAL_PATTERN})*)\\s*\\)\\s*\\)`,
  'gi',
)

export function readEnumChecks(definition: string): { name?: string, column: string, values: string[] }[] {
  return [...definition.matchAll(ENUM_CHECK_PATTERN)].flatMap(([, name, column, values]) => column === undefined || values === undefined
    ? []
    : [{
        ...(name ? { name: unquoteIdentifier(name) } : {}),
        column: unquoteIdentifier(column),
        values: readStringLiterals(values),
      }])
}

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
    const reference = readColumnConstraints(definition).find(constraint => constraint.keyword === 'REFERENCES')
    if (!reference) return undefined
    return reference.name === undefined ? { column: columnName } : { column: columnName, name: reference.name }
  }

  const [, name, column] = definition.match(TABLE_FOREIGN_KEY_PATTERN) ?? []
  if (column === undefined) return undefined
  return name ? { column: unquoteIdentifier(column), name: unquoteIdentifier(name) } : { column: unquoteIdentifier(column) }
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}

interface SqlToken {
  readonly start: number
  readonly end: number
  readonly word?: string
}

const WORD_CHARACTER_PATTERN = /[\w$]/

function quotedTextEnd(sql: string, start: number, closingQuote: string): number {
  for (let index = sql.indexOf(closingQuote, start + 1); index !== -1; index = sql.indexOf(closingQuote, index + 2)) {
    if (closingQuote === ']' || sql.charAt(index + 1) !== closingQuote) return index + 1
  }
  return sql.length
}

function tokenEnd(sql: string, start: number): number {
  const character = sql.charAt(start)
  const closingQuote = QUOTE_PAIRS[character]
  if (closingQuote) return quotedTextEnd(sql, start, closingQuote)
  if (character === '(') {
    const closeIndex = findClosingParenthesis(sql, start)
    return closeIndex === -1 ? sql.length : closeIndex + 1
  }
  if (!WORD_CHARACTER_PATTERN.test(character)) return start + 1

  let end = start + 1
  while (end < sql.length && WORD_CHARACTER_PATTERN.test(sql.charAt(end))) end += 1
  return end
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  for (let start = 0; start < sql.length;) {
    const commentEndIndex = commentEnd(sql, start)
    if (commentEndIndex !== undefined) {
      start = commentEndIndex
      continue
    }
    if (/\s/.test(sql.charAt(start))) {
      start += 1
      continue
    }
    const end = tokenEnd(sql, start)
    const text = sql.slice(start, end)
    tokens.push(WORD_CHARACTER_PATTERN.test(text.charAt(0)) ? { start, end, word: text.toUpperCase() } : { start, end })
    start = end
  }
  return tokens
}

const COLUMN_CONSTRAINT_KEYWORDS = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS'])

function startsColumnConstraint(tokens: readonly SqlToken[], index: number): boolean {
  const word = tokens[index]?.word
  if (word === undefined || !COLUMN_CONSTRAINT_KEYWORDS.has(word)) return false

  const previous = tokens[index - 1]?.word
  if (previous === 'CONSTRAINT' || tokens[index - 2]?.word === 'CONSTRAINT') return false
  if (word === 'NULL') return previous !== 'NOT' && previous !== 'SET' && previous !== 'DEFAULT'
  if (word === 'DEFAULT') return previous !== 'SET'
  if (word === 'NOT') return tokens[index + 1]?.word !== 'DEFERRABLE'
  if (word === 'AS') return previous !== 'ALWAYS'
  return true
}

interface ColumnConstraint {
  readonly keyword: string
  readonly name?: string
  readonly words: readonly string[]
  readonly text: string
}

interface ColumnDefinitionParts {
  readonly nameAndType: string
  readonly constraints: readonly ColumnConstraint[]
}

function readColumnConstraint(definition: string, tokens: readonly SqlToken[]): ColumnConstraint {
  const first = tokens[0]
  const last = tokens[tokens.length - 1]
  const text = first && last ? definition.slice(first.start, last.end) : ''
  const words = tokens.flatMap(token => token.word === undefined ? [] : [token.word])
  const nameToken = first?.word === 'CONSTRAINT' ? tokens[1] : undefined
  const keyword = (nameToken ? tokens[2]?.word : first?.word) ?? ''
  return nameToken
    ? { keyword, name: unquoteIdentifier(definition.slice(nameToken.start, nameToken.end)), words, text }
    : { keyword, words, text }
}

function readColumnDefinitionParts(definition: string): ColumnDefinitionParts {
  const tokens = tokenize(definition)
  const starts = tokens.flatMap((_token, index) => index > 0 && startsColumnConstraint(tokens, index) ? [index] : [])
  const nameAndTypeEnd = tokens[(starts[0] ?? tokens.length) - 1]?.end ?? 0
  return {
    nameAndType: definition.slice(0, nameAndTypeEnd).trim(),
    constraints: starts.map((start, position) => readColumnConstraint(definition, tokens.slice(start, starts[position + 1]))),
  }
}

function readColumnConstraints(definition: string): readonly ColumnConstraint[] {
  return readColumnDefinitionParts(definition).constraints
}

export function isAutoIncrementDefinition(definition: string): boolean {
  return readColumnConstraints(definition)
    .some(constraint => constraint.keyword === 'PRIMARY' && constraint.words.includes('AUTOINCREMENT'))
}

const CHANGED_COLUMN_CONSTRAINT_KEYWORDS = new Set(['NOT', 'NULL', 'DEFAULT'])

export function readPreservedColumnConstraints(definition: string, columnName: string): string[] {
  return readColumnConstraints(definition)
    .filter(constraint => !CHANGED_COLUMN_CONSTRAINT_KEYWORDS.has(constraint.keyword))
    .filter(constraint => constraint.keyword !== 'CHECK' || !readEnumChecks(constraint.text).some(check => check.column === columnName))
    .map(constraint => constraint.text)
}

function withoutColumnConstraints(definition: string, removes: (constraint: ColumnConstraint) => boolean): string | undefined {
  const { nameAndType, constraints } = readColumnDefinitionParts(definition)
  const kept = constraints.filter(constraint => !removes(constraint))
  if (kept.length === constraints.length) return undefined
  return [nameAndType, ...kept.map(constraint => constraint.text)].join(' ')
}

export function withoutInlinePrimaryKey(definition: string): string {
  return withoutColumnConstraints(definition, constraint => constraint.keyword === 'PRIMARY') ?? definition
}

const TABLE_UNIQUE_PATTERN = new RegExp(`^(?:CONSTRAINT\\s+(?:${IDENTIFIER_PATTERN})\\s+)?UNIQUE\\s*\\(([^)]*)\\)`, 'i')

function readTableUniqueColumns(definition: string): string[] | undefined {
  const match = definition.match(TABLE_UNIQUE_PATTERN)
  return match?.[1]?.split(',').map(column => readColumnDefinitionName(column.trim()) ?? column.trim())
}

function rewriteDefinitions(
  definitions: readonly string[],
  rewrite: (definition: string, columnName: string | undefined) => string | null | undefined,
): string[] | undefined {
  let rewroteAny = false
  const kept: string[] = []
  for (const definition of definitions) {
    const rewritten = rewrite(definition, readColumnDefinitionName(definition))
    if (rewritten === undefined) {
      kept.push(definition)
      continue
    }
    rewroteAny = true
    if (rewritten !== null) kept.push(rewritten)
  }
  return rewroteAny ? kept : undefined
}

export function withoutForeignKeyDefinitions(
  definitions: readonly string[],
  matches: (foreignKey: ForeignKeyDefinition) => boolean,
): string[] | undefined {
  return rewriteDefinitions(definitions, (definition, columnName) => {
    if (columnName) {
      return withoutColumnConstraints(definition, constraint => constraint.keyword === 'REFERENCES'
        && matches(constraint.name === undefined ? { column: columnName } : { column: columnName, name: constraint.name }))
    }
    const foreignKey = readForeignKey(definition, columnName)
    return foreignKey && matches(foreignKey) ? null : undefined
  })
}

export function withoutUniqueDefinitions(definitions: readonly string[], columns: readonly string[]): string[] | undefined {
  return rewriteDefinitions(definitions, (definition, columnName) => {
    if (columnName) {
      return columns.length === 1 && columns[0] === columnName
        ? withoutColumnConstraints(definition, constraint => constraint.keyword === 'UNIQUE')
        : undefined
    }
    return readTableUniqueColumns(definition)?.join('\0') === columns.join('\0') ? null : undefined
  })
}
