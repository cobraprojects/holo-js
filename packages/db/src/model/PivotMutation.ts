import { randomUUID } from 'node:crypto'
import { HydrationError, SecurityError } from '../core/errors'
import type { DatabaseContext } from '../core/DatabaseContext'
import { TableQueryBuilder, selectMatchingValues, selectStoredText, whereStoredValuesDiffer, whereStoredValuesIn } from '../query/TableQueryBuilder'
import { normalizeDateColumnPredicateValue, normalizeQueryPredicateValue, normalizeQueryWriteValue } from '../query/queryValueNormalizer'
import { formatCalendarDate } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { assertQueryTablePath } from '../query/validator'
import { parseStoredDate, readsAsInteger, storesDate } from '../schema/normalization'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import { assertColumnWritable, canonicalStoredKey, ownEntry } from './entityRuntime'

type Attributes = Record<string, unknown>
type Entry = { id: unknown, attributes: Attributes }
type PivotUpdate = { readonly when: 'always' } | { readonly when: 'datesDiffer', readonly columns: readonly string[] }
type InsertAction = Entry & { readonly kind: 'insert' }
type UpdateAction = Entry & { readonly kind: 'update', readonly keys: readonly unknown[], readonly update: PivotUpdate, readonly onUpdated: () => void }
type DeleteAction = { readonly kind: 'delete', readonly keys: readonly unknown[] }
type Action = InsertAction | UpdateAction | DeleteAction
type Result = { attached: unknown[], detached: unknown[], updated: unknown[] }
type Context = {
  table: string | TableDefinition
  scope: Attributes
  relatedColumn: string
  relatedKey: AnyColumnDefinition | undefined
  loadTable?: () => Promise<TableDefinition | undefined>
  loadColumnSqlTypes?: () => Promise<ReadonlyMap<string, string>>
  dialect: SchemaDialectName
  allowedColumns: readonly string[]
  timestamps: boolean
  relationName: string
}
type PivotQuery = TableQueryBuilder<string | TableDefinition>

const bindingBudget = 900
const SECONDS_FRACTION = /\d{2}:\d{2}:\d{2}\.(\d+)/
const CALENDAR_DATE = /^\d{4,}-\d{2}-\d{2}$/

function bindableId(id: unknown): unknown {
  return ArrayBuffer.isView(id) && !(id instanceof Uint8Array) ? new Uint8Array(id.buffer, id.byteOffset, id.byteLength) : id
}

function isScalarObjectId(id: unknown): id is Date | ArrayBufferView {
  return id instanceof Date || ArrayBuffer.isView(id)
}

export class PivotMutation {
  private readonly aliasSuffix = randomUUID().replaceAll('-', '')
  private readonly storedKeyTextAlias = `holo_stored_key_${this.aliasSuffix}`
  private readonly matchingValuesAlias = `holo_matching_${this.aliasSuffix}`
  private relatedKey: AnyColumnDefinition | undefined
  private loadedTable: TableDefinition | undefined
  private readonly targetKeyCache = new WeakMap<readonly Attributes[], unknown[]>()
  private readonly othersDifferCache = new WeakMap<readonly Attributes[], Map<string, boolean>>()
  private relatedKeyLoaded = false

  constructor(private readonly context: Context, private readonly connection: DatabaseContext) {
    assertQueryTablePath(typeof context.table === 'string' ? context.table : context.table.tableName)
  }

  private async loadRelatedKey(): Promise<void> {
    if (this.relatedKeyLoaded) return
    if (typeof this.context.table === 'string' && !getConnectionGeneratedTableDefinition(this.context.table, this.connection.getConnectionName())) {
      this.loadedTable = await this.context.loadTable?.()
    }
    const table = this.tableDefinition()
    this.relatedKey = this.context.relatedKey ?? (table ? ownEntry(table.columns, this.context.relatedColumn) : undefined)
    this.relatedKeyLoaded = true
  }

  async attach(ids: unknown, attributes: Attributes): Promise<void> {
    await this.mutate('attach', ids, attributes)
  }

  async sync(ids: unknown, detachMissing: boolean): Promise<Result> {
    return this.mutate('sync', ids, {}, detachMissing)
  }

  async toggle(ids: unknown): Promise<Omit<Result, 'updated'>> {
    const { attached, detached } = await this.mutate('toggle', ids)
    return { attached, detached }
  }

  async detach(ids?: unknown): Promise<number> {
    await this.loadRelatedKey()
    return this.connection.transaction(async connection => {
      if (ids == null) return this.delete(connection)
      const entries = this.normalize(ids)
      if (entries.length === 0) return 0
      if (!this.dateKeyColumn()) return this.delete(connection, entries.map(entry => entry.id))
      const unique = this.dedupe(entries)
      const matches = await this.match(connection, unique, false)
      const keys = new Set<unknown>()
      for (const entry of unique) {
        for (const key of this.storedKeys(matches.rowsFor(entry) ?? [])) keys.add(key)
      }
      return keys.size === 0 ? 0 : this.delete(connection, [...keys])
    })
  }

  async update(id: unknown, attributes: Attributes): Promise<number> {
    await this.loadRelatedKey()
    this.validate(attributes)
    if (Object.keys(attributes).length === 0) return 0
    const entry = { id: bindableId(id), attributes }
    return this.connection.transaction(async (connection) => {
      const existing = this.dateKeyColumn()
        ? (await this.match(connection, [entry], false)).rowsFor(entry) ?? []
        : (await this.read(connection, [entry.id])).slice(0, 1)
      const update = existing.length === 0 ? undefined : this.updateFor(existing, attributes)
      if (!update) return 0
      const values = this.timestampAttributes(attributes, false)
      this.assertColumnsWritable(Object.keys(values))
      return await this.updateRows(connection, this.targetKeys(existing, entry.id), values, update) ? 1 : 0
    })
  }

  private async mutate(kind: 'attach' | 'sync' | 'toggle', ids: unknown, attributes: Attributes = {}, detachMissing = false): Promise<Result> {
    await this.loadRelatedKey()
    const normalized = this.normalize(ids, attributes)
    const entries = kind === 'attach' ? normalized : this.dedupe(normalized)
    for (const entry of entries) this.validate(entry.attributes)
    this.assertColumnsWritable(entries.flatMap(entry => Object.keys(entry.attributes)))
    const result: Result = { attached: [], detached: [], updated: [] }
    if (kind !== 'sync' && entries.length === 0) return result

    await this.connection.transaction(async connection => {
      const matches = await this.match(connection, entries, kind === 'sync')
      const actions: Action[] = []
      for (const entry of entries) {
        const existing = matches.rowsFor(entry)
        if (kind === 'toggle' && existing) {
          actions.push({ kind: 'delete', keys: this.targetKeys(existing, entry.id) })
          result.detached.push(entry.id)
        } else if (!existing) {
          actions.push({ ...entry, kind: 'insert' })
          result.attached.push(entry.id)
        } else if (kind !== 'toggle') {
          const update = this.updateFor(existing, entry.attributes)
          if (update) actions.push({ ...entry, kind: 'update', keys: this.targetKeys(existing, entry.id), update, onUpdated: () => result.updated.push(entry.id) })
        }
      }
      const detachments: Action[] = []
      if (detachMissing) {
        for (const missing of await matches.missing()) {
          const keys = this.storedKeys(missing)
          if (keys.length === 0) continue
          detachments.push({ kind: 'delete', keys })
          for (const row of missing) result.detached.push(this.readKey(row[this.context.relatedColumn]))
        }
      }
      await this.execute(connection, [...detachments, ...actions])
    })
    return result
  }

  private async execute(connection: DatabaseContext, actions: readonly Action[]): Promise<void> {
    const timestamp = new Date()
    const timestamped = this.context.timestamps ? actions.map(action => action.kind === 'delete' ? action : {
      ...action,
      attributes: this.timestampAttributes(action.attributes, action.kind === 'insert', timestamp),
    }) : actions
    this.assertColumnsWritable(timestamped.flatMap(action => this.writtenColumns(action)))
    let offset = 0
    while (offset < timestamped.length) {
      const action = timestamped[offset]!
      offset++
      if (action.kind === 'update') {
        if (await this.updateRows(connection, action.keys, action.attributes, action.update)) action.onUpdated()
        continue
      }
      if (action.kind === 'delete') {
        const keys = [...action.keys]
        while (offset < timestamped.length && timestamped[offset]!.kind === 'delete' && keys.length < this.idBatchSize()) {
          for (const key of (timestamped[offset] as DeleteAction).keys) keys.push(key)
          offset++
        }
        await this.delete(connection, keys)
        continue
      }
      const columns = Object.keys(action.attributes)
      const rowWidth = Object.keys(this.context.scope).length + 1 + columns.length
      const limit = Math.max(1, Math.floor(bindingBudget / rowWidth))
      const batch: InsertAction[] = [action]
      while (offset < timestamped.length && batch.length < limit) {
        const next = timestamped[offset]!
        if (next.kind !== 'insert') break
        const keys = Object.keys(next.attributes)
        if (keys.length !== columns.length || !columns.every(column => keys.includes(column))) break
        batch.push(next)
        offset++
      }
      await new TableQueryBuilder(this.context.table, connection).insert(batch.map(entry => ({
        ...this.context.scope,
        [this.context.relatedColumn]: entry.id,
        ...entry.attributes,
      })))
    }
  }

  private writtenColumns(action: Action): string[] {
    if (action.kind === 'delete') return []
    const columns = Object.keys(action.attributes)
    return action.kind === 'insert' ? [...Object.keys(this.context.scope), this.context.relatedColumn, ...columns] : columns
  }

  private timestampAttributes(attributes: Attributes, inserting: boolean, timestamp = new Date()): Attributes {
    if (!this.context.timestamps) return attributes
    return {
      ...attributes,
      ...(inserting ? { created_at: attributes.created_at ?? timestamp } : {}),
      updated_at: timestamp,
    }
  }

  private normalize(ids: unknown, attributes: Attributes = {}): Entry[] {
    if (ids == null) return []
    if (Array.isArray(ids)) return ids.map(id => ({ id: this.castId(bindableId(id)), attributes: { ...attributes } }))
    if (typeof ids === 'object' && !isScalarObjectId(ids)) {
      return Object.entries(ids as Record<string, Attributes>).map(([id, value]) => ({
        id: this.objectKey(id),
        attributes: { ...(value ?? {}) },
      }))
    }
    return [{ id: this.castId(bindableId(ids)), attributes: { ...attributes } }]
  }

  private castId(id: unknown): unknown {
    const column = this.relatedKeyLoaded ? this.relatedKey : this.context.relatedKey
    if (!column || !readsAsInteger(column)) return id
    if (typeof id === 'string') return this.objectKey(id)
    const unsafe = (typeof id === 'number' && Number.isInteger(id) && !Number.isSafeInteger(id))
      || (typeof id === 'bigint' && (id > BigInt(Number.MAX_SAFE_INTEGER) || id < BigInt(Number.MIN_SAFE_INTEGER)))
    if (unsafe) this.assertReadableInteger(id)
    return id
  }

  private groupByKey(rows: readonly Attributes[]): Map<unknown, Attributes[]> {
    const groups = new Map<unknown, Attributes[]>()
    for (const row of rows) {
      const identity = this.storedKeyIdentity(row)
      const group = groups.get(identity)
      if (group) group.push(row)
      else groups.set(identity, [row])
    }
    return groups
  }

  private targetKeys(existing: readonly Attributes[], incoming: unknown): unknown[] {
    if (!this.dateKeyColumn()) return [incoming]
    const cached = this.targetKeyCache.get(existing)
    if (cached) return cached
    const keys = this.storedKeys(existing)
    this.targetKeyCache.set(existing, keys)
    return keys
  }

  private objectKey(id: string): unknown {
    const column = this.relatedKeyLoaded ? this.relatedKey : this.context.relatedKey
    if (column && !readsAsInteger(column)) return id
    if (!/^-?\d+$/.test(id)) return id
    const integer = Number(id)
    if (Number.isSafeInteger(integer)) return integer
    this.assertReadableInteger(id)
    return id
  }

  private assertReadableInteger(id: unknown): void {
    const table = this.writtenTableDefinition()
    const column = table ? ownEntry(table.columns, this.context.relatedColumn) : undefined
    if (column && readsAsInteger(column)) throw new HydrationError(`Integer value "${String(id)}" cannot be represented as a safe integer.`)
  }

  private storedKeys(rows: readonly Attributes[]): unknown[] {
    return [...new Set(rows.map(row => this.storedKey(row)).filter(key => typeof key !== 'undefined'))]
  }

  private storedKey(row: Attributes): unknown {
    return this.comparesKeysInDatabase() ? row[this.storedKeyTextAlias] : row[this.context.relatedColumn]
  }

  private storedKeyIdentity(row: Attributes): unknown {
    const stored = this.storedKey(row)
    if (this.storesSQLiteDateKeys() && this.dateKeyColumn()?.kind !== 'date') return this.sqliteInstantIdentity(stored, stored)
    return this.incomingKeyIdentity(stored)
  }

  private incomingKeyIdentity(value: unknown): unknown {
    if (this.storesSQLiteDateKeys()) {
      if (this.dateKeyColumn()?.kind === 'date') return this.calendarDayIdentity(this.writeKey(value))
      const written = this.writeKey(value)
      return this.sqliteInstantIdentity(written, written)
    }
    return this.keyIdentity(this.readKey(this.writeKey(value)))
  }

  private sqliteInstantIdentity(value: unknown, precise: unknown): unknown {
    const written = this.writeKey(value)
    if (typeof written !== 'string') return this.keyIdentity(written)
    const instant = parseStoredDate('sqlite', written)
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return this.keyIdentity(written)
    const fraction = typeof precise === 'string' ? SECONDS_FRACTION.exec(precise)?.[1] ?? '' : ''
    return `instant:${instant.getTime()}|${fraction.slice(3).replace(/0+$/, '')}`
  }

  private calendarDayIdentity(value: unknown): unknown {
    if (typeof value === 'string' && CALENDAR_DATE.test(value)) return `day:${value}`
    const instant = parseStoredDate(this.context.dialect, value)
    return instant instanceof Date && !Number.isNaN(instant.getTime())
      ? `day:${formatCalendarDate(instant, getApplicationTimezone())}`
      : this.keyIdentity(value)
  }

  private storesSQLiteDateKeys(): boolean {
    return this.context.dialect === 'sqlite' && this.dateKeyColumn() !== undefined
  }

  private comparesKeysInDatabase(): boolean {
    return this.context.dialect !== 'sqlite' && this.dateKeyColumn() !== undefined
  }

  private async match(connection: DatabaseContext, entries: readonly Entry[], readAll: boolean): Promise<{ rowsFor(entry: Entry): Attributes[] | undefined, missing(): Promise<Attributes[][]> }> {
    if (this.comparesKeysInDatabase()) {
      const byEntry = new Map<Entry, Attributes[]>()
      const representatives = new Map<unknown, Entry>()
      const shared = new Map<Entry, Entry>()
      for (const entry of entries) {
        const identity = this.dedupeIdentity(entry.id)
        const representative = representatives.get(identity)
        if (representative) shared.set(entry, representative)
        else representatives.set(identity, entry)
      }
      const unique = [...representatives.values()]
      const batchSize = Math.max(1, Math.floor(this.idBatchSize() / 2))
      for (let offset = 0; offset < unique.length; offset += batchSize) {
        const batch = unique.slice(offset, offset + batchSize)
        const ids = batch.map(entry => entry.id)
        const query = selectMatchingValues(
          this.query(connection).where(this.context.relatedColumn, 'in', ids) as never,
          this.context.relatedColumn,
          ids.map(id => this.comparedKey(id)),
          this.matchingValuesAlias,
        ) as unknown as PivotQuery
        for (const row of await this.readWithStoredText(query)) {
          for (const index of String(row[this.matchingValuesAlias] ?? '').split(',').filter(Boolean)) {
            const entry = batch[Number(index)]!
            const rows = byEntry.get(entry)
            if (rows) rows.push(row)
            else byEntry.set(entry, [row])
          }
        }
      }
      for (const [entry, representative] of shared) {
        const rows = byEntry.get(representative)
        if (rows) byEntry.set(entry, rows)
      }
      return {
        rowsFor: entry => byEntry.get(entry),
        missing: async () => {
          if (!readAll) return []
          const kept = new Set<string>()
          for (const rows of new Set(byEntry.values())) {
            for (const row of rows) kept.add(String(row[this.storedKeyTextAlias]))
          }
          return [(await this.readWithStoredText(this.query(connection))).filter(row => row[this.context.relatedColumn] != null && !kept.has(String(row[this.storedKeyTextAlias])))]
        },
      }
    }
    const current = this.groupByKey(await this.read(connection, readAll ? undefined : entries.map(entry => entry.id)))
    const desired = new Set(entries.map(entry => this.incomingKeyIdentity(entry.id)))
    return {
      rowsFor: (entry) => {
        const rows = current.get(this.incomingKeyIdentity(entry.id))
        return rows && !this.dateKeyColumn() ? rows.slice(-1) : rows
      },
      missing: async () => [...current].filter(([identity]) => !desired.has(identity)).map(([, rows]) => rows),
    }
  }

  private comparedKey(id: unknown): unknown {
    const table = this.writtenTableDefinition()
    return table && this.dateKeyColumn()?.kind === 'date'
      ? normalizeDateColumnPredicateValue(table, this.context.dialect, this.context.relatedColumn, id, '=').value
      : normalizeQueryPredicateValue(table, this.context.dialect, this.context.relatedColumn, id)
  }

  private readWithStoredText(query: PivotQuery): Promise<Attributes[]> {
    return selectStoredText(query.addSelect(`${this.tableName()}.*` as never) as PivotQuery, this.context.relatedColumn, this.storedKeyTextAlias).get<Attributes>()
  }

  private writeKey(value: unknown): unknown {
    return this.dateKeyColumn() ? normalizeQueryWriteValue(this.writtenTableDefinition(), this.context.dialect, this.context.relatedColumn, value) : value
  }

  private keyIdentity(key: unknown): unknown {
    return isScalarObjectId(key) ? canonicalStoredKey(key) : `value:${String(key)}`
  }

  private readKey(value: unknown): unknown {
    if (!this.dateKeyColumn() || this.context.dialect === 'sqlite') return value
    const parsed = parseStoredDate(this.context.dialect, value)
    return parsed instanceof Date && Number.isNaN(parsed.getTime()) ? value : parsed
  }

  private dateKeyColumn(): AnyColumnDefinition | undefined {
    const column = this.relatedKeyLoaded ? this.relatedKey : this.context.relatedKey
    return column && storesDate(column) ? column : undefined
  }

  private dedupeIdentity(id: unknown): unknown {
    return this.keyIdentity(this.writeKey(id))
  }

  private dedupe(entries: readonly Entry[]): Entry[] {
    return [...new Map(entries.map(entry => [this.dedupeIdentity(entry.id), entry])).values()]
  }

  private validate(attributes: Attributes): void {
    for (const column of Object.keys(attributes)) {
      if (column === this.context.relatedColumn || Object.prototype.hasOwnProperty.call(this.context.scope, column)) {
        throw new SecurityError(`Pivot attribute "${column}" on relation "${this.context.relationName}" is reserved and cannot be set explicitly.`)
      }
      if (!this.context.allowedColumns.includes(column)) {
        throw new SecurityError(`Pivot attribute "${column}" on relation "${this.context.relationName}" must be declared with withPivot(...) before it can be written.`)
      }
    }
  }

  private assertColumnsWritable(columns: readonly string[]): void {
    const table = this.context.table
    if (typeof table === 'string') return
    for (const column of new Set(columns)) assertColumnWritable(column, ownEntry(table.columns, column), 'computed')
  }

  private updateFor(existing: readonly Attributes[], attributes: Attributes): PivotUpdate | undefined {
    const last = existing.at(-1)
    if (!last || Object.keys(attributes).length === 0) return undefined
    const dates = Object.entries(attributes).filter(([column, value]) => this.comparesInDatabase(column, value, last)).map(([column]) => column)
    const others = Object.entries(attributes).filter(([column]) => !dates.includes(column))
    if (others.length > 0 && this.othersDiffer(this.dateKeyColumn() ? existing : [last], others)) return { when: 'always' }
    return dates.length === 0 ? undefined : { when: 'datesDiffer', columns: dates }
  }

  private othersDiffer(rows: readonly Attributes[], others: readonly (readonly [string, unknown])[]): boolean {
    if (others.some(([, value]) => typeof value === 'object' && value !== null && !(value instanceof Date))) {
      return rows.some(row => others.some(([column, value]) => row[column] !== value))
    }
    const key = JSON.stringify(others.map(([column, value]) => [column, typeof value, value instanceof Date ? value.getTime() : String(value)]))
    const cached = this.othersDifferCache.get(rows)?.get(key)
    if (cached !== undefined) return cached
    const differs = rows.some(row => others.some(([column, value]) => row[column] !== value))
    const byKey = this.othersDifferCache.get(rows) ?? new Map<string, boolean>()
    byKey.set(key, differs)
    this.othersDifferCache.set(rows, byKey)
    return differs
  }

  private comparesInDatabase(column: string, value: unknown, existing: Attributes): boolean {
    const definition = this.tableDefinition()
    const columnDefinition = definition ? ownEntry(definition.columns, column) : undefined
    return columnDefinition ? storesDate(columnDefinition) : value instanceof Date || existing[column] instanceof Date
  }

  private calendarDateColumns(columns: readonly string[]): string[] {
    const definition = this.tableDefinition()
    return columns.filter(column => (definition ? ownEntry(definition.columns, column) : undefined)?.kind === 'date')
  }

  private tableName(): string {
    return typeof this.context.table === 'string' ? this.context.table : this.context.table.tableName
  }

  private writtenTableDefinition(): TableDefinition | undefined {
    const table = this.context.table
    return typeof table === 'string' ? getConnectionGeneratedTableDefinition(table, this.connection.getConnectionName()) : table
  }

  private tableDefinition(): TableDefinition | undefined {
    const table = this.context.table
    return typeof table === 'string' ? getConnectionGeneratedTableDefinition(table, this.connection.getConnectionName()) ?? this.loadedTable : table
  }

  private async updateRows(connection: DatabaseContext, keys: readonly unknown[], values: Attributes, update: PivotUpdate): Promise<boolean> {
    const compared = update.when === 'datesDiffer'
      ? Object.fromEntries(update.columns.map(column => [column, normalizeQueryWriteValue(this.writtenTableDefinition(), this.context.dialect, column, values[column])]))
      : {}
    const sqlTypes = update.when === 'datesDiffer' && this.context.dialect !== 'sqlite' ? await this.context.loadColumnSqlTypes?.() : undefined
    const batchSize = Math.max(1, this.idBatchSize() - Object.keys(values).length - Object.keys(compared).length)
    let changed = false
    for (let offset = 0; offset < keys.length; offset += batchSize) {
      const rows = this.whereKeys(this.query(connection), keys.slice(offset, offset + batchSize))
      const result = await (update.when === 'always' ? rows : whereStoredValuesDiffer(rows, compared, this.calendarDateColumns(Object.keys(compared)), sqlTypes)).update(values)
      changed = changed || update.when === 'always' || (result.affectedRows ?? 0) > 0
    }
    return changed
  }

  private whereKeys(query: PivotQuery, keys: readonly unknown[]): PivotQuery {
    return this.dateKeyColumn() ? whereStoredValuesIn(query, this.context.relatedColumn, keys) : query.where(this.context.relatedColumn, 'in', keys)
  }

  private query(connection: DatabaseContext): PivotQuery {
    let query = new TableQueryBuilder(this.context.table, connection)
    for (const [column, value] of Object.entries(this.context.scope)) query = query.where(column, value)
    return query
  }

  private idBatchSize(): number {
    return bindingBudget - Object.keys(this.context.scope).length
  }

  private async read(connection: DatabaseContext, ids?: readonly unknown[]): Promise<Attributes[]> {
    if (!ids || this.storesSQLiteDateKeys()) return this.query(connection).get<Attributes>()
    const rows: Attributes[] = []
    const unique = [...new Set(ids)]
    for (let offset = 0; offset < unique.length; offset += this.idBatchSize()) {
      for (const row of await this.query(connection).where(this.context.relatedColumn, 'in', unique.slice(offset, offset + this.idBatchSize())).get<Attributes>()) rows.push(row)
    }
    return rows
  }

  private async delete(connection: DatabaseContext, keys?: readonly unknown[]): Promise<number> {
    if (!keys) return (await this.query(connection).delete()).affectedRows ?? 0
    let count = 0
    for (let offset = 0; offset < keys.length; offset += this.idBatchSize()) {
      const batch = keys.slice(offset, offset + this.idBatchSize())
      const result = await this.whereKeys(this.query(connection), batch).delete()
      count += result.affectedRows ?? 0
    }
    return count
  }
}
