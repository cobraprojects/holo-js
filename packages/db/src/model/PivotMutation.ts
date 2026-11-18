import { SecurityError } from '../core/errors'
import type { DatabaseContext } from '../core/DatabaseContext'
import { TableQueryBuilder, whereStoredValuesIn } from '../query/TableQueryBuilder'
import { assertQueryTablePath } from '../query/validator'
import { normalizeDialectWriteValue, parseStoredDate, storesDate } from '../schema/normalization'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import { assertColumnWritable, canonicalStoredKey, ownEntry } from './entityRuntime'

type Attributes = Record<string, unknown>
type Entry = { id: unknown, attributes: Attributes }
type Action = Entry & {
  kind: 'insert' | 'update' | 'delete'
  readonly key?: unknown
  readonly onlyWhereDatesDiffer?: readonly string[]
  readonly onUpdated?: () => void
}
type PivotUpdate = { readonly onlyWhereDatesDiffer?: readonly string[] }
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

const bindingBudget = 900

function bindableId(id: unknown): unknown {
  return ArrayBuffer.isView(id) && !(id instanceof Uint8Array) ? new Uint8Array(id.buffer, id.byteOffset, id.byteLength) : id
}

function isScalarObjectId(id: unknown): id is Date | ArrayBufferView {
  return id instanceof Date || ArrayBuffer.isView(id)
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
      if (!this.readsAllRows()) return this.delete(connection, entries.map(entry => entry.id))
      const wanted = new Set(entries.map(entry => this.incomingKeyIdentity(entry.id)))
      const keys = (await this.read(connection)).filter(row => wanted.has(this.storedKeyIdentity(row))).map(row => row[this.context.relatedColumn])
      return keys.length === 0 ? 0 : this.delete(connection, keys)
    })
  }

  async update(id: unknown, attributes: Attributes): Promise<number> {
    this.validate(attributes)
    if (Object.keys(attributes).length === 0) return 0
    const key = bindableId(id)
    const rows = await this.read(this.connection, [key])
    const existing = this.readsAllRows() ? rows.find(row => this.storedKeyIdentity(row) === this.incomingKeyIdentity(key)) : rows[0]
    const update = existing && this.updateFor(existing, attributes)
    if (!existing || !update) return 0
    const values = this.timestampAttributes(attributes, false)
    this.assertColumnsWritable(Object.keys(values))
    const result = await this.updateRow(this.connection, existing[this.context.relatedColumn], values, update.onlyWhereDatesDiffer)
    return update.onlyWhereDatesDiffer && !((result.affectedRows ?? 0) > 0) ? 0 : 1
  }

  private async mutate(kind: 'attach' | 'sync' | 'toggle', ids: unknown, attributes: Attributes = {}, detachMissing = false): Promise<Result> {
    const normalized = this.normalize(ids, attributes)
    const entries = kind === 'attach' ? normalized : this.dedupe(normalized)
    for (const entry of entries) this.validate(entry.attributes)
    this.assertColumnsWritable(entries.flatMap(entry => Object.keys(entry.attributes)))
    const result: Result = { attached: [], detached: [], updated: [] }
    if (kind !== 'sync' && entries.length === 0) return result

    await this.connection.transaction(async connection => {
      const rows = await this.read(connection, kind === 'sync' ? undefined : entries.map(entry => entry.id))
      const current = new Map(rows.map(row => [this.storedKeyIdentity(row), row]))
      const actions: Action[] = []
      for (const entry of entries) {
        const existing = current.get(this.incomingKeyIdentity(entry.id))
        if (kind === 'toggle' && existing) {
          actions.push({ ...entry, kind: 'delete', key: existing[this.context.relatedColumn] })
          result.detached.push(entry.id)
        } else if (!existing) {
          actions.push({ ...entry, kind: 'insert' })
          result.attached.push(entry.id)
        } else if (kind !== 'toggle') {
          const update = this.updateFor(existing, entry.attributes)
          if (update) actions.push({ ...entry, ...update, kind: 'update', key: existing[this.context.relatedColumn], onUpdated: () => result.updated.push(entry.id) })
        }
      }
      if (detachMissing) {
        const desired = new Set(entries.map(entry => this.incomingKeyIdentity(entry.id)))
        for (const row of rows) {
          const id = row[this.context.relatedColumn]
          if (!desired.has(this.storedKeyIdentity(row)) && typeof id !== 'undefined') {
            actions.push({ kind: 'delete', id, key: id, attributes: {} })
            result.detached.push(this.readKey(id))
          }
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
      if (action.kind === 'update') {
        const updated = await this.updateRow(connection, action.key, action.attributes, action.onlyWhereDatesDiffer)
        if (!action.onlyWhereDatesDiffer || (updated.affectedRows ?? 0) > 0) action.onUpdated?.()
        offset++
        continue
      }
      const columns = Object.keys(action.attributes)
      const rowWidth = Object.keys(this.context.scope).length + 1 + columns.length
      const limit = action.kind === 'insert' ? Math.max(1, Math.floor(bindingBudget / rowWidth)) : this.idBatchSize()
      const batch: Action[] = [action]
      offset++
      while (offset < timestamped.length && batch.length < limit) {
        const next = timestamped[offset]!
        if (next.kind !== action.kind) break
        const keys = Object.keys(next.attributes)
        if (action.kind === 'insert' && (keys.length !== columns.length || !columns.every(column => keys.includes(column)))) break
        batch.push(next)
        offset++
      }
      if (action.kind === 'delete') {
        await this.delete(connection, batch.map(entry => 'key' in entry ? entry.key : entry.id))
      } else {
        await new TableQueryBuilder(this.context.table, connection).insert(batch.map(entry => ({
          ...this.context.scope,
          [this.context.relatedColumn]: entry.id,
          ...entry.attributes,
        })))
      }
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

  private storedKeyIdentity(row: Attributes): unknown {
    return this.incomingKeyIdentity(row[this.context.relatedColumn])
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
    return column?.kind === 'date' || column?.kind === 'datetime' || column?.kind === 'timestamp' ? column : undefined
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

  private updateFor(existing: Attributes, attributes: Attributes): PivotUpdate | undefined {
    const dates = Object.keys(attributes).filter(column => this.storesDateAttribute(column))
    if (Object.entries(attributes).some(([column, value]) => !dates.includes(column) && existing[column] !== value)) return {}
    return dates.length === 0 ? undefined : { onlyWhereDatesDiffer: dates }
  }

  private storesDateAttribute(column: string): boolean {
    const definition = typeof this.context.table === 'string' ? undefined : ownEntry(this.context.table.columns, column)
    return definition !== undefined && storesDate(definition)
  }

  private updateRow(connection: DatabaseContext, key: unknown, values: Attributes, onlyWhereDatesDiffer?: readonly string[]) {
    const row = this.whereKeys(this.query(connection), [key])
    const query = onlyWhereDatesDiffer
      ? row.where(group => onlyWhereDatesDiffer.reduce((differs, column) => differs.orWhere(match => values[column] == null
        ? match.whereNotNull(column)
        : match.where(column, '!=', values[column]).orWhereNull(column)), group))
      : row
    return query.update(values)
  }

  private readsAllRows(): boolean {
    return this.context.dialect === 'sqlite' && this.dateKeyColumn() !== undefined
  }

  private whereKeys(query: TableQueryBuilder<string | TableDefinition>, keys: readonly unknown[]): TableQueryBuilder<string | TableDefinition> {
    return this.readsAllRows() ? whereStoredValuesIn(query, this.context.relatedColumn, keys) : query.where(this.context.relatedColumn, 'in', keys)
  }

  private query(connection: DatabaseContext): TableQueryBuilder<string | TableDefinition> {
    let query = new TableQueryBuilder(this.context.table, connection)
    for (const [column, value] of Object.entries(this.context.scope)) query = query.where(column, value)
    return query
  }

  private idBatchSize(): number {
    return bindingBudget - Object.keys(this.context.scope).length
  }

  private async read(connection: DatabaseContext, ids?: readonly unknown[]): Promise<Attributes[]> {
    if (!ids || this.readsAllRows()) return this.query(connection).get<Attributes>()
    const rows: Attributes[] = []
    const unique = [...new Set(ids)]
    for (let offset = 0; offset < unique.length; offset += this.idBatchSize()) {
      rows.push(...await this.query(connection).where(this.context.relatedColumn, 'in', unique.slice(offset, offset + this.idBatchSize())).get<Attributes>())
    }
    return rows
  }

  private async delete(connection: DatabaseContext, ids?: readonly unknown[]): Promise<number> {
    if (!ids) return (await this.query(connection).delete()).affectedRows ?? 0
    let count = 0
    for (let offset = 0; offset < ids.length; offset += this.idBatchSize()) {
      const result = await this.whereKeys(this.query(connection), ids.slice(offset, offset + this.idBatchSize())).delete()
      count += result.affectedRows ?? 0
    }
    return count
  }
}
