import { SchemaError } from '../../core/errors'
import { readNameToken, sliceTokens, splitTokensOnCommas, tokenizeSql, type SqlToken } from './sqliteTokens'

export interface KeyColumn {
  readonly name: string
  readonly collation?: string
  readonly descending: boolean
}

interface ForeignKeyClause {
  readonly table: string
  readonly columns: readonly string[]
  readonly onDelete: string
  readonly onUpdate: string
  readonly match?: string
  readonly deferral?: string
}

interface ConstraintSource {
  readonly name?: string
  readonly text: string
}

type PrimaryKeyConstraint = ConstraintSource & { readonly kind: 'PRIMARY KEY', readonly columns: readonly KeyColumn[], readonly autoIncrement: boolean }
type UniqueConstraint = ConstraintSource & { readonly kind: 'UNIQUE', readonly columns: readonly KeyColumn[] }
type CheckConstraint = ConstraintSource & { readonly kind: 'CHECK', readonly expression: readonly SqlToken[] }
export type ForeignKeyConstraint = ConstraintSource & { readonly kind: 'FOREIGN KEY', readonly columns: readonly string[], readonly references: ForeignKeyClause }
type CollateConstraint = ConstraintSource & { readonly kind: 'COLLATE', readonly collation: string }
type ColumnAttributeConstraint = ConstraintSource & { readonly kind: 'NOT NULL' | 'NULL' | 'DEFAULT' | 'GENERATED' | 'DEFERRABLE' | 'NAME' }

export type StoredConstraint
  = | PrimaryKeyConstraint
    | UniqueConstraint
    | CheckConstraint
    | ForeignKeyConstraint
    | CollateConstraint
    | ColumnAttributeConstraint

export interface StoredColumn {
  readonly name: string
  readonly type: string
  readonly declaration: string
  readonly text: string
  readonly constraints: readonly StoredConstraint[]
}

export interface StoredTable {
  readonly columns: readonly StoredColumn[]
  readonly constraints: readonly StoredConstraint[]
  readonly options: string
}

type WithoutSource<TConstraint> = TConstraint extends ConstraintSource ? Omit<TConstraint, keyof ConstraintSource> : never
type ConstraintBody = WithoutSource<StoredConstraint>

const TABLE_CONSTRAINT_STARTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])
const COLUMN_CONSTRAINT_KEYWORDS = new Set(['CONSTRAINT', 'NULL', 'UNIQUE', 'DEFAULT', 'COLLATE', 'REFERENCES', 'DEFERRABLE'])
const FOREIGN_KEY_EVENTS = new Set(['DELETE', 'UPDATE', 'INSERT'])
const FOREIGN_KEY_ACTIONS = [['SET', 'NULL'], ['SET', 'DEFAULT'], ['CASCADE'], ['RESTRICT'], ['NO', 'ACTION']] as const
const DEFAULT_FOREIGN_KEY_ACTION = 'NO ACTION'

class TokenCursor {
  index = 0

  constructor(private readonly sql: string, private readonly tokens: readonly SqlToken[]) {}

  get done(): boolean {
    return this.index >= this.tokens.length
  }

  peek(offset = 0): SqlToken | undefined {
    return this.tokens[this.index + offset]
  }

  keyword(offset = 0): string | undefined {
    const token = this.peek(offset)
    return token?.kind === 'word' ? token.keyword : undefined
  }

  next(): SqlToken | undefined {
    const token = this.peek()
    if (token) this.index += 1
    return token
  }

  accept(...keywords: string[]): boolean {
    if (!keywords.every((keyword, offset) => this.keyword(offset) === keyword)) return false
    this.index += keywords.length
    return true
  }

  expectGroup(): SqlToken {
    const token = this.peek()
    if (token?.kind !== 'group') this.fail()
    this.index += 1
    return token
  }

  expectName(): string {
    const name = readNameToken(this.peek())
    if (name === undefined) this.fail()
    this.index += 1
    return name
  }

  groupItems(): TokenCursor[] {
    return splitTokensOnCommas(this.expectGroup().children ?? []).map(item => new TokenCursor(this.sql, item))
  }

  textFrom(start: number): string {
    return sliceTokens(this.sql, this.tokens.slice(start, this.index))
  }

  fail(): never {
    const token = this.peek()
    const found = token ? `"${this.sql.slice(token.start, token.end)}"` : 'the end of the definition'
    throw new SchemaError(`SQLite cannot read the stored table definition: unexpected ${found}.`)
  }
}

function readGroupNames(cursor: TokenCursor): string[] {
  return cursor.groupItems().map((item) => {
    const name = item.expectName()
    if (!item.done) item.fail()
    return name
  })
}

function readDescending(cursor: TokenCursor): boolean {
  if (cursor.accept('DESC')) return true
  cursor.accept('ASC')
  return false
}

function readKeyColumn(item: TokenCursor): { column: KeyColumn, autoIncrement: boolean } {
  const name = item.expectName()
  const collation = item.accept('COLLATE') ? item.expectName() : undefined
  const descending = readDescending(item)
  const autoIncrement = item.accept('AUTOINCREMENT')
  if (!item.done) item.fail()
  return { column: { name, ...(collation === undefined ? {} : { collation }), descending }, autoIncrement }
}

function readKeyColumns(cursor: TokenCursor): { columns: KeyColumn[], autoIncrement: boolean } {
  const keyColumns = cursor.groupItems().map(readKeyColumn)
  return { columns: keyColumns.map(keyColumn => keyColumn.column), autoIncrement: keyColumns.some(keyColumn => keyColumn.autoIncrement) }
}

function skipConflictClause(cursor: TokenCursor): void {
  if (cursor.accept('ON', 'CONFLICT')) cursor.expectName()
}

function readDeferral(cursor: TokenCursor): string | undefined {
  const start = cursor.index
  if (!cursor.accept('NOT', 'DEFERRABLE') && !cursor.accept('DEFERRABLE')) return undefined
  if (cursor.accept('INITIALLY') && !cursor.accept('DEFERRED') && !cursor.accept('IMMEDIATE')) cursor.fail()
  return cursor.textFrom(start)
}

function readForeignKeyAction(cursor: TokenCursor): string {
  const action = FOREIGN_KEY_ACTIONS.find(words => cursor.accept(...words))
  if (!action) cursor.fail()
  return action.join(' ')
}

type MatchClause = { readonly kind: 'MATCH', readonly name: string }
type ActionClause = { readonly kind: 'ON', readonly event: string, readonly action: string }
type ForeignKeyTailClause = MatchClause | ActionClause

function readForeignKeyTailClause(cursor: TokenCursor): ForeignKeyTailClause {
  if (cursor.accept('MATCH')) return { kind: 'MATCH', name: cursor.expectName() }
  cursor.accept('ON')
  const event = cursor.keyword()
  if (event === undefined || !FOREIGN_KEY_EVENTS.has(event)) cursor.fail()
  cursor.next()
  return { kind: 'ON', event, action: readForeignKeyAction(cursor) }
}

function readForeignKeyTailClauses(cursor: TokenCursor): ForeignKeyTailClause[] {
  if (cursor.keyword() !== 'ON' && cursor.keyword() !== 'MATCH') return []
  const clause = readForeignKeyTailClause(cursor)
  return [clause, ...readForeignKeyTailClauses(cursor)]
}

function readForeignKeyClause(cursor: TokenCursor): ForeignKeyClause {
  const table = cursor.expectName()
  const columns = cursor.peek()?.kind === 'group' ? readGroupNames(cursor) : []
  const latestFirst = readForeignKeyTailClauses(cursor).reverse()
  const actionFor = (event: string): string => latestFirst
    .find((clause): clause is ActionClause => clause.kind === 'ON' && clause.event === event)?.action ?? DEFAULT_FOREIGN_KEY_ACTION
  const match = latestFirst.find((clause): clause is MatchClause => clause.kind === 'MATCH')?.name
  const deferral = readDeferral(cursor)
  return {
    table,
    columns,
    onDelete: actionFor('DELETE'),
    onUpdate: actionFor('UPDATE'),
    ...(match === undefined ? {} : { match }),
    ...(deferral === undefined ? {} : { deferral }),
  }
}

function startsColumnConstraint(cursor: TokenCursor): boolean {
  const keyword = cursor.keyword()
  if (keyword === undefined) return false
  if (COLUMN_CONSTRAINT_KEYWORDS.has(keyword)) return true
  switch (keyword) {
    case 'PRIMARY': return cursor.keyword(1) === 'KEY'
    case 'NOT': return cursor.keyword(1) === 'NULL' || cursor.keyword(1) === 'DEFERRABLE'
    case 'CHECK':
    case 'AS': return cursor.peek(1)?.kind === 'group'
    case 'GENERATED': return cursor.keyword(1) === 'ALWAYS' && cursor.keyword(2) === 'AS'
    default: return false
  }
}

function skipDefaultValue(cursor: TokenCursor): void {
  const value = cursor.next()
  if (value?.kind === 'symbol' && (value.value === '+' || value.value === '-')) cursor.next()
  else if (value === undefined || value.kind === 'symbol') cursor.fail()
}

function readGeneratedTail(cursor: TokenCursor): ConstraintBody {
  cursor.accept('GENERATED', 'ALWAYS')
  if (!cursor.accept('AS')) cursor.fail()
  cursor.expectGroup()
  if (!cursor.accept('STORED')) cursor.accept('VIRTUAL')
  return { kind: 'GENERATED' }
}

function readColumnConstraintBody(cursor: TokenCursor, columnName: string): ConstraintBody {
  if (cursor.done || cursor.keyword() === 'CONSTRAINT') return { kind: 'NAME' }
  if (cursor.accept('PRIMARY', 'KEY')) {
    const descending = readDescending(cursor)
    skipConflictClause(cursor)
    return { kind: 'PRIMARY KEY', columns: [{ name: columnName, descending }], autoIncrement: cursor.accept('AUTOINCREMENT') }
  }
  if (readDeferral(cursor) !== undefined) return { kind: 'DEFERRABLE' }
  for (const kind of ['NOT NULL', 'NULL', 'UNIQUE'] as const) {
    if (cursor.accept(...kind.split(' '))) {
      skipConflictClause(cursor)
      return kind === 'UNIQUE' ? { kind, columns: [{ name: columnName, descending: false }] } : { kind }
    }
  }
  if (cursor.accept('CHECK')) return { kind: 'CHECK', expression: cursor.expectGroup().children ?? [] }
  if (cursor.accept('DEFAULT')) {
    skipDefaultValue(cursor)
    return { kind: 'DEFAULT' }
  }
  if (cursor.accept('COLLATE')) return { kind: 'COLLATE', collation: cursor.expectName() }
  if (cursor.accept('REFERENCES')) return { kind: 'FOREIGN KEY', columns: [columnName], references: readForeignKeyClause(cursor) }
  if (cursor.keyword() === 'GENERATED' || cursor.keyword() === 'AS') return readGeneratedTail(cursor)
  return cursor.fail()
}

function readConstraintName(cursor: TokenCursor): string | undefined {
  return cursor.accept('CONSTRAINT') ? cursor.expectName() : undefined
}

function withSource(cursor: TokenCursor, start: number, name: string | undefined, body: ConstraintBody): StoredConstraint {
  return { ...body, ...(name === undefined ? {} : { name }), text: cursor.textFrom(start) }
}

function readColumnConstraint(cursor: TokenCursor, columnName: string): StoredConstraint {
  const start = cursor.index
  const name = readConstraintName(cursor)
  return withSource(cursor, start, name, readColumnConstraintBody(cursor, columnName))
}

function skipTypeName(cursor: TokenCursor): void {
  while (!cursor.done && !startsColumnConstraint(cursor)) {
    if (cursor.peek()?.kind === 'group') {
      cursor.next()
      return
    }
    cursor.expectName()
  }
}

function readColumn(sql: string, tokens: readonly SqlToken[]): StoredColumn {
  const cursor = new TokenCursor(sql, tokens)
  const name = cursor.expectName()
  const typeStart = cursor.index
  skipTypeName(cursor)
  const type = cursor.textFrom(typeStart)
  const declaration = cursor.textFrom(0)
  const constraints: StoredConstraint[] = []
  while (!cursor.done) constraints.push(readColumnConstraint(cursor, name))
  return { name, type, declaration, text: cursor.textFrom(0), constraints }
}

function readTableConstraintBody(cursor: TokenCursor): ConstraintBody {
  if (cursor.done || cursor.keyword() === 'CONSTRAINT') return { kind: 'NAME' }
  if (cursor.accept('CHECK')) {
    const expression = cursor.expectGroup().children ?? []
    skipConflictClause(cursor)
    return { kind: 'CHECK', expression }
  }
  if (cursor.accept('FOREIGN', 'KEY')) {
    const columns = readGroupNames(cursor)
    if (!cursor.accept('REFERENCES')) cursor.fail()
    return { kind: 'FOREIGN KEY', columns, references: readForeignKeyClause(cursor) }
  }
  if (cursor.accept('PRIMARY', 'KEY')) {
    const key = readKeyColumns(cursor)
    skipConflictClause(cursor)
    return { kind: 'PRIMARY KEY', ...key }
  }
  if (!cursor.accept('UNIQUE')) cursor.fail()
  const { columns } = readKeyColumns(cursor)
  skipConflictClause(cursor)
  return { kind: 'UNIQUE', columns }
}

function readTableConstraints(sql: string, tokens: readonly SqlToken[]): StoredConstraint[] {
  const cursor = new TokenCursor(sql, tokens)
  const constraints: StoredConstraint[] = []
  while (!cursor.done) {
    const start = cursor.index
    const name = readConstraintName(cursor)
    constraints.push(withSource(cursor, start, name, readTableConstraintBody(cursor)))
  }
  return constraints
}

function startsTableConstraint(tokens: readonly SqlToken[]): boolean {
  const first = tokens[0]
  return first?.kind === 'word' && TABLE_CONSTRAINT_STARTS.has(first.keyword ?? '')
}

function declaresOrdinaryTable(cursor: TokenCursor): boolean {
  if (!cursor.accept('CREATE')) return false
  if (!cursor.accept('TEMP')) cursor.accept('TEMPORARY')
  return cursor.accept('TABLE')
}

export function parseCreateTableSql(createTableSql: string): StoredTable | undefined {
  const tokens = tokenizeSql(createTableSql)
  if (!declaresOrdinaryTable(new TokenCursor(createTableSql, tokens))) return undefined
  const bodyIndex = tokens.findIndex(token => token.kind === 'group')
  const body = tokens[bodyIndex]
  if (!body?.children) return undefined
  const definitions = splitTokensOnCommas(body.children)
  const constraintsStart = definitions.findIndex(startsTableConstraint)
  const columnDefinitions = constraintsStart === -1 ? definitions : definitions.slice(0, constraintsStart)
  const constraintDefinitions = constraintsStart === -1 ? [] : definitions.slice(constraintsStart)
  return {
    columns: columnDefinitions.map(definition => readColumn(createTableSql, definition)),
    constraints: constraintDefinitions.flatMap(definition => readTableConstraints(createTableSql, definition)),
    options: sliceTokens(createTableSql, tokens.slice(bodyIndex + 1)),
  }
}

export function findCreateIndexNameToken(createIndexSql: string): SqlToken | undefined {
  const cursor = new TokenCursor(createIndexSql, tokenizeSql(createIndexSql))
  if (!cursor.accept('CREATE')) return undefined
  cursor.accept('UNIQUE')
  if (!cursor.accept('INDEX')) return undefined
  cursor.accept('IF', 'NOT', 'EXISTS')
  if (cursor.peek(1)?.value === '.') cursor.index += 2
  const name = cursor.peek()
  return readNameToken(name) === undefined ? undefined : name
}
