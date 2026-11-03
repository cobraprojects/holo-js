import { readNameToken, sliceTokens, splitTokensOnCommas, tokenizeSql, type SqlToken } from './sqliteTokens'

export type ColumnConstraintKind = 'PRIMARY KEY' | 'NOT NULL' | 'NULL' | 'UNIQUE' | 'CHECK' | 'DEFAULT' | 'COLLATE' | 'REFERENCES' | 'GENERATED' | 'DEFERRABLE' | 'UNKNOWN'
export type TableConstraintKind = 'PRIMARY KEY' | 'UNIQUE' | 'CHECK' | 'FOREIGN KEY'

export interface ForeignKeyTarget {
  readonly table: string
  readonly columns: readonly string[]
}

export interface ColumnConstraint {
  readonly kind: ColumnConstraintKind
  readonly name?: string
  readonly text: string
  readonly autoIncrement: boolean
  readonly check?: SqlToken
  readonly references?: ForeignKeyTarget
}

export interface ColumnDefinitionSql {
  readonly kind: 'column'
  readonly name: string
  readonly nameAndType: string
  readonly constraints: readonly ColumnConstraint[]
}

export interface TableConstraintSql {
  readonly kind: TableConstraintKind
  readonly name?: string
  readonly columns: readonly string[]
  readonly check?: SqlToken
  readonly references?: ForeignKeyTarget
}

export type TableDefinitionSql = ColumnDefinitionSql | TableConstraintSql

const COLUMN_CONSTRAINT_STARTS = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS', 'DEFERRABLE'])
const TABLE_CONSTRAINT_STARTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])
const FOREIGN_KEY_EVENTS = new Set(['DELETE', 'UPDATE', 'INSERT'])
const TWO_WORD_FOREIGN_KEY_ACTIONS = new Set(['SET', 'NO'])

class TokenCursor {
  index = 0

  constructor(private readonly tokens: readonly SqlToken[]) {}

  get done(): boolean {
    return this.index >= this.tokens.length
  }

  peek(offset = 0): SqlToken | undefined {
    return this.tokens[this.index + offset]
  }

  keyword(offset = 0): string | undefined {
    return this.peek(offset)?.keyword
  }

  next(): SqlToken | undefined {
    const token = this.peek()
    if (token) this.index += 1
    return token
  }

  skip(count: number): void {
    this.index = Math.min(this.index + count, this.tokens.length)
  }

  accept(...keywords: string[]): boolean {
    if (!keywords.every((keyword, offset) => this.keyword(offset) === keyword)) return false
    this.skip(keywords.length)
    return true
  }

  acceptGroup(): SqlToken | undefined {
    return this.peek()?.kind === 'group' ? this.next() : undefined
  }

  slice(start: number): SqlToken[] {
    return this.tokens.slice(start, this.index)
  }
}

function readGroupNames(group: SqlToken | undefined): string[] {
  return splitTokensOnCommas(group?.children ?? []).flatMap(item => readNameToken(item[0]) ?? [])
}

function readOptionalConstraintName(cursor: TokenCursor): string | undefined {
  if (cursor.keyword() !== 'CONSTRAINT') return undefined
  cursor.skip(1)
  return readNameToken(cursor.next())
}

function skipConflictClause(cursor: TokenCursor): void {
  if (cursor.accept('ON', 'CONFLICT')) cursor.skip(1)
}

function skipDeferrableClause(cursor: TokenCursor): boolean {
  if (!cursor.accept('NOT', 'DEFERRABLE') && !cursor.accept('DEFERRABLE')) return false
  if (cursor.accept('INITIALLY')) cursor.skip(1)
  return true
}

function skipForeignKeyArgument(cursor: TokenCursor): boolean {
  if (cursor.keyword() === 'ON' && FOREIGN_KEY_EVENTS.has(cursor.keyword(1) ?? '')) {
    cursor.skip(TWO_WORD_FOREIGN_KEY_ACTIONS.has(cursor.keyword(2) ?? '') ? 4 : 3)
    return true
  }
  if (!cursor.accept('MATCH')) return false
  cursor.skip(1)
  return true
}

function readForeignKeyClause(cursor: TokenCursor): ForeignKeyTarget {
  const table = readNameToken(cursor.next()) ?? ''
  const columns = readGroupNames(cursor.acceptGroup())
  while (skipForeignKeyArgument(cursor));
  skipDeferrableClause(cursor)
  return { table, columns }
}

function skipDefaultValue(cursor: TokenCursor): void {
  const value = cursor.next()
  if (value?.kind === 'symbol' && (value.value === '+' || value.value === '-')) cursor.skip(1)
}

function skipGeneratedTail(cursor: TokenCursor): void {
  cursor.accept('AS')
  cursor.acceptGroup()
  if (cursor.keyword() === 'STORED' || cursor.keyword() === 'VIRTUAL') cursor.skip(1)
}

interface ConstraintBody {
  readonly kind: ColumnConstraintKind
  readonly autoIncrement?: boolean
  readonly check?: SqlToken
  readonly references?: ForeignKeyTarget
}

function readColumnConstraintBody(cursor: TokenCursor): ConstraintBody {
  if (cursor.accept('PRIMARY', 'KEY')) {
    if (cursor.keyword() === 'ASC' || cursor.keyword() === 'DESC') cursor.skip(1)
    skipConflictClause(cursor)
    return { kind: 'PRIMARY KEY', autoIncrement: cursor.accept('AUTOINCREMENT') }
  }
  if (skipDeferrableClause(cursor)) return { kind: 'DEFERRABLE' }
  if (cursor.accept('NOT', 'NULL')) {
    skipConflictClause(cursor)
    return { kind: 'NOT NULL' }
  }
  for (const kind of ['NULL', 'UNIQUE'] as const) {
    if (cursor.accept(kind)) {
      skipConflictClause(cursor)
      return { kind }
    }
  }
  if (cursor.accept('CHECK')) return { kind: 'CHECK', check: cursor.acceptGroup() }
  if (cursor.accept('DEFAULT')) {
    skipDefaultValue(cursor)
    return { kind: 'DEFAULT' }
  }
  if (cursor.accept('COLLATE')) {
    cursor.skip(1)
    return { kind: 'COLLATE' }
  }
  if (cursor.accept('REFERENCES')) return { kind: 'REFERENCES', references: readForeignKeyClause(cursor) }
  if (cursor.accept('GENERATED', 'ALWAYS') || cursor.keyword() === 'AS') {
    skipGeneratedTail(cursor)
    return { kind: 'GENERATED' }
  }
  cursor.skip(1)
  return { kind: 'UNKNOWN' }
}

function readColumnConstraint(definition: string, cursor: TokenCursor): ColumnConstraint {
  const start = cursor.index
  const name = readOptionalConstraintName(cursor)
  const { kind, autoIncrement = false, check, references } = readColumnConstraintBody(cursor)
  return {
    kind,
    ...(name === undefined ? {} : { name }),
    text: sliceTokens(definition, cursor.slice(start)),
    autoIncrement,
    ...(check ? { check } : {}),
    ...(references ? { references } : {}),
  }
}

function skipTypeName(cursor: TokenCursor): void {
  while (!cursor.done && !COLUMN_CONSTRAINT_STARTS.has(cursor.keyword() ?? '')) {
    if (cursor.next()?.kind === 'group') return
  }
}

function readColumnDefinition(definition: string, cursor: TokenCursor): ColumnDefinitionSql {
  const name = readNameToken(cursor.next()) ?? ''
  skipTypeName(cursor)
  const nameAndType = sliceTokens(definition, cursor.slice(0))
  const constraints: ColumnConstraint[] = []
  while (!cursor.done) constraints.push(readColumnConstraint(definition, cursor))
  return { kind: 'column', name, nameAndType, constraints }
}

function readTableConstraint(cursor: TokenCursor): TableConstraintSql {
  const name = readOptionalConstraintName(cursor)
  const named = name === undefined ? {} : { name }
  if (cursor.accept('CHECK')) {
    const check = cursor.acceptGroup()
    return { kind: 'CHECK', ...named, columns: [], ...(check ? { check } : {}) }
  }
  if (cursor.accept('FOREIGN', 'KEY')) {
    const columns = readGroupNames(cursor.acceptGroup())
    cursor.accept('REFERENCES')
    return { kind: 'FOREIGN KEY', ...named, columns, references: readForeignKeyClause(cursor) }
  }
  const kind = cursor.accept('PRIMARY', 'KEY') ? 'PRIMARY KEY' : 'UNIQUE'
  cursor.accept('UNIQUE')
  return { kind, ...named, columns: readGroupNames(cursor.acceptGroup()) }
}

function startsTableConstraint(tokens: readonly SqlToken[]): boolean {
  const first = tokens[0]
  return first?.kind === 'word' && TABLE_CONSTRAINT_STARTS.has(first.keyword ?? '')
}

export function parseTableDefinition(definition: string): TableDefinitionSql {
  const tokens = tokenizeSql(definition)
  const cursor = new TokenCursor(tokens)
  return startsTableConstraint(tokens) ? readTableConstraint(cursor) : readColumnDefinition(definition, cursor)
}

export interface CreateTableSql {
  readonly definitions: string[]
  readonly options: string
}

export function splitCreateTableSql(createTableSql: string): CreateTableSql | undefined {
  const tokens = tokenizeSql(createTableSql)
  const bodyIndex = tokens.findIndex(token => token.kind === 'group')
  const body = tokens[bodyIndex]
  if (!body?.children) return undefined
  return {
    definitions: splitTokensOnCommas(body.children).map(item => sliceTokens(createTableSql, item)),
    options: sliceTokens(createTableSql, tokens.slice(bodyIndex + 1)),
  }
}

export function findCreateIndexNameToken(createIndexSql: string): SqlToken | undefined {
  const cursor = new TokenCursor(tokenizeSql(createIndexSql))
  if (!cursor.accept('CREATE')) return undefined
  cursor.accept('UNIQUE')
  if (!cursor.accept('INDEX')) return undefined
  cursor.accept('IF', 'NOT', 'EXISTS')
  if (cursor.peek(1)?.value === '.') cursor.skip(2)
  const name = cursor.peek()
  return readNameToken(name) === undefined ? undefined : name
}
