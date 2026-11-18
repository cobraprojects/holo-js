import { SecurityError } from '../core/errors'
import type { DatabaseContext } from '../core/DatabaseContext'
import { TableQueryBuilder, whereStoredValuesIn } from '../query/TableQueryBuilder'
import { assertQueryTablePath } from '../query/validator'
import { normalizeDialectWriteValue, parseStoredDate, readsAsSQLiteDate, storesDate } from '../schema/normalization'
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
  dialect: SchemaDialectName
  allowedColumns: readonly string[]
  timestamps: boolean
  relationName: string
}
type PivotQuery = TableQueryBuilder<string | TableDefinition>

const bindingBudget = 900

function bindableId(id: unknown): unknown {
  return ArrayBuffer.isView(id) && !(id instanceof Uint8Array) ? new Uint8Array(id.buffer, id.byteOffset, id.byteLength) : id
}

function isScalarObjectId(id: unknown): id is Date | ArrayBufferView {
  return id instanceof Date || ArrayBuffer.isView(id)
}

function orWhereDiffers(query: PivotQuery, column: string, value: unknown): PivotQuery {
  return query.orWhere(match => value == null
    ? match.whereNotNull(column)
    : match.where(column, '!=', value).orWhereNull(column))
}

export class PivotMutation {
  constructor(private readonly context: Context, private readonly connection: DatabaseContext) {
    assertQueryTablePath(typeof context.table === 'string' ? context.table : context.table.tableName)
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
    return this.connection.transaction(async connection => {
      if (ids == null) return this.delete(connection)
      const entries = this.normalize(ids)
      if (entries.length === 0) return 0
      if (!this.storesSQLiteDateKeys()) return this.delete(connection, entries.map(entry => entry.id))
      const current = this.groupByKey(await this.read(connection))
      const keys = [...new Set(entries.map(entry => this.incomingKeyIdentity(entry.id)))]
        .flatMap(identity => this.storedKeys(current.get(identity) ?? []))
      return keys.length === 0 ? 0 : this.delete(connection, keys)
    })
  }

  async update(id: unknown, attributes: Attributes): Promise<number> {
    this.validate(attributes)
    if (Object.keys(attributes).length === 0) return 0
    const key = bindableId(id)
    const rows = await this.read(this.connection, [key])
    const existing = this.storesSQLiteDateKeys() ? this.groupByKey(rows).get(this.incomingKeyIdentity(key)) ?? [] : rows.slice(0, 1)
    const update = existing.length === 0 ? undefined : this.updateFor(existing, attributes)
    if (!update) return 0
    const values = this.timestampAttributes(attributes, false)
    this.assertColumnsWritable(Object.keys(values))
    return await this.updateRows(this.connection, this.storedKeys(existing), values, update) ? 1 : 0
  }

  private async mutate(kind: 'attach' | 'sync' | 'toggle', ids: unknown, attributes: Attributes = {}, detachMissing = false): Promise<Result> {
    const normalized = this.normalize(ids, attributes)
    const entries = kind === 'attach' ? normalized : this.dedupe(normalized)
    for (const entry of entries) this.validate(entry.attributes)
    this.assertColumnsWritable(entries.flatMap(entry => Object.keys(entry.attributes)))
    const result: Result = { attached: [], detached: [], updated: [] }
    if (kind !== 'sync' && entries.length === 0) return result

    await this.connection.transaction(async connection => {
      const current = this.groupByKey(await this.read(connection, kind === 'sync' ? undefined : entries.map(entry => entry.id)))
      const actions: Action[] = []
      for (const entry of entries) {
        const existing = current.get(this.incomingKeyIdentity(entry.id))
        if (kind === 'toggle' && existing) {
          actions.push({ kind: 'delete', keys: this.storedKeys(existing) })
          result.detached.push(entry.id)
        } else if (!existing) {
          actions.push({ ...entry, kind: 'insert' })
          result.attached.push(entry.id)
        } else if (kind !== 'toggle') {
          const update = this.updateFor(existing, entry.attributes)
          if (update) actions.push({ ...entry, kind: 'update', keys: this.storedKeys(existing), update, onUpdated: () => result.updated.push(entry.id) })
        }
      }
      if (detachMissing) {
        const desired = new Set(entries.map(entry => this.incomingKeyIdentity(entry.id)))
        for (const [identity, rows] of current) {
          const keys = this.storedKeys(rows)
          if (desired.has(identity) || keys.length === 0) continue
          actions.push({ kind: 'delete', keys })
          result.detached.push(...keys.map(key => this.readKey(key)))
        }
      }
      await this.execute(connection, actions)
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
          keys.push(...(timestamped[offset] as DeleteAction).keys)
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
    if (Array.isArray(ids)) return ids.map(id => ({ id: bindableId(id), attributes: { ...attributes } }))
    if (typeof ids === 'object' && !isScalarObjectId(ids)) {
      return Object.entries(ids as Record<string, Attributes>).map(([id, value]) => ({
        id: /^-?\d+$/.test(id) ? Number(id) : id,
        attributes: { ...(value ?? {}) },
      }))
    }
    return [{ id: bindableId(ids), attributes: { ...attributes } }]
  }

  private groupByKey(rows: readonly Attributes[]): Map<unknown, Attributes[]> {
    const groups = new Map<unknown, Attributes[]>()
    for (const row of rows) {
      const identity = this.incomingKeyIdentity(row[this.context.relatedColumn])
      groups.set(identity, [...groups.get(identity) ?? [], row])
    }
    return groups
  }

  private storedKeys(rows: readonly Attributes[]): unknown[] {
    return rows.map(row => row[this.context.relatedColumn]).filter(key => typeof key !== 'undefined')
  }

  private incomingKeyIdentity(value: unknown): unknown {
    return this.keyIdentity(this.readKey(this.writeKey(value)))
  }

  private writeKey(value: unknown): unknown {
    const column = this.dateKeyColumn()
    return column ? normalizeDialectWriteValue(this.context.dialect, column, value) : value
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
    const column = this.context.relatedKey
    return column && storesDate(column) ? column : undefined
  }

  private storesSQLiteDateKeys(): boolean {
    const column = this.context.relatedKey
    return column !== undefined && readsAsSQLiteDate(this.context.dialect, column)
  }

  private dedupe(entries: readonly Entry[]): Entry[] {
    return [...new Map(entries.map(entry => [this.keyIdentity(this.writeKey(entry.id)), entry])).values()]
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
    const dates = Object.keys(attributes).filter(column => this.storesDateAttribute(column))
    const others = Object.entries(attributes).filter(([column]) => !dates.includes(column))
    if (existing.some(row => others.some(([column, value]) => row[column] !== value))) return { when: 'always' }
    return dates.length === 0 ? undefined : { when: 'datesDiffer', columns: dates }
  }

  private storesDateAttribute(column: string): boolean {
    const definition = typeof this.context.table === 'string' ? undefined : ownEntry(this.context.table.columns, column)
    return definition !== undefined && storesDate(definition)
  }

  private async updateRows(connection: DatabaseContext, keys: readonly unknown[], values: Attributes, update: PivotUpdate): Promise<boolean> {
    const rows = this.whereKeys(this.query(connection), keys)
    if (update.when === 'always') {
      await rows.update(values)
      return true
    }
    const changed = rows.where(group => update.columns.reduce((differs, column) => orWhereDiffers(differs, column, values[column]), group))
    return ((await changed.update(values)).affectedRows ?? 0) > 0
  }

  private whereKeys(query: PivotQuery, keys: readonly unknown[]): PivotQuery {
    return this.storesSQLiteDateKeys() ? whereStoredValuesIn(query, this.context.relatedColumn, keys) : query.where(this.context.relatedColumn, 'in', keys)
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
      rows.push(...await this.query(connection).where(this.context.relatedColumn, 'in', unique.slice(offset, offset + this.idBatchSize())).get<Attributes>())
    }
    return rows
  }

  private async delete(connection: DatabaseContext, keys?: readonly unknown[]): Promise<number> {
    if (!keys) return (await this.query(connection).delete()).affectedRows ?? 0
    let count = 0
    for (let offset = 0; offset < keys.length; offset += this.idBatchSize()) {
      const result = await this.whereKeys(this.query(connection), keys.slice(offset, offset + this.idBatchSize())).delete()
      count += result.affectedRows ?? 0
    }
    return count
  }
}
