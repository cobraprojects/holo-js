import { SecurityError } from '../core/errors'
import type { DatabaseContext } from '../core/DatabaseContext'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { TableDefinition } from '../schema/types'

type Attributes = Record<string, unknown>
type Entry = { id: unknown, attributes: Attributes }
type Action = Entry & { kind: 'insert' | 'update' | 'delete' }
type Result = { attached: unknown[], detached: unknown[], updated: unknown[] }
type Context = {
  table: string | TableDefinition
  scope: Attributes
  relatedColumn: string
  allowedColumns: readonly string[]
  relationName: string
}

const bindingBudget = 900

export class PivotMutation {
  constructor(private readonly context: Context, private readonly connection: DatabaseContext) {}

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
      return entries.length === 0 ? 0 : this.delete(connection, entries.map(entry => entry.id))
    })
  }

  async update(id: unknown, attributes: Attributes): Promise<number> {
    this.validate(attributes)
    if (Object.keys(attributes).length === 0) return 0
    const [existing] = await this.read(this.connection, [id])
    if (!existing || !this.changed(existing, attributes)) return 0
    await this.query(this.connection).where(this.context.relatedColumn, id).update(attributes)
    return 1
  }

  private async mutate(kind: 'attach' | 'sync' | 'toggle', ids: unknown, attributes: Attributes = {}, detachMissing = false): Promise<Result> {
    const entries = this.normalize(ids, attributes)
    for (const entry of entries) this.validate(entry.attributes)
    const result: Result = { attached: [], detached: [], updated: [] }
    if (kind !== 'sync' && entries.length === 0) return result

    await this.connection.transaction(async connection => {
      const rows = await this.read(connection, kind === 'sync' ? undefined : entries.map(entry => entry.id))
      const current = new Map(rows.map(row => [String(row[this.context.relatedColumn]), row]))
      const actions: Action[] = []
      for (const entry of entries) {
        const existing = current.get(String(entry.id))
        if (kind === 'toggle' && existing) {
          actions.push({ ...entry, kind: 'delete' })
          result.detached.push(entry.id)
        } else if (!existing) {
          actions.push({ ...entry, kind: 'insert' })
          result.attached.push(entry.id)
        } else if (kind !== 'toggle' && this.changed(existing, entry.attributes)) {
          actions.push({ ...entry, kind: 'update' })
          result.updated.push(entry.id)
        }
      }
      if (detachMissing) {
        const desired = new Set(entries.map(entry => String(entry.id)))
        for (const [key, row] of current) {
          const id = row[this.context.relatedColumn]
          if (!desired.has(key) && typeof id !== 'undefined') {
            actions.push({ kind: 'delete', id, attributes: {} })
            result.detached.push(id)
          }
        }
      }
      await this.execute(connection, actions)
    })
    return result
  }

  private async execute(connection: DatabaseContext, actions: readonly Action[]): Promise<void> {
    let offset = 0
    while (offset < actions.length) {
      const action = actions[offset]!
      if (action.kind === 'update') {
        await this.query(connection).where(this.context.relatedColumn, action.id).update(action.attributes)
        offset++
        continue
      }
      const columns = Object.keys(action.attributes)
      const rowWidth = Object.keys(this.context.scope).length + 1 + columns.length
      const limit = action.kind === 'insert' ? Math.max(1, Math.floor(bindingBudget / rowWidth)) : this.idBatchSize()
      const batch: Action[] = [action]
      offset++
      while (offset < actions.length && batch.length < limit) {
        const next = actions[offset]!
        if (next.kind !== action.kind) break
        const keys = Object.keys(next.attributes)
        if (action.kind === 'insert' && (keys.length !== columns.length || !columns.every(column => keys.includes(column)))) break
        batch.push(next)
        offset++
      }
      if (action.kind === 'delete') {
        await this.delete(connection, batch.map(entry => entry.id))
      } else {
        await new TableQueryBuilder(this.context.table, connection).insert(batch.map(entry => ({
          ...this.context.scope,
          [this.context.relatedColumn]: entry.id,
          ...entry.attributes,
        })))
      }
    }
  }

  private normalize(ids: unknown, attributes: Attributes = {}): Entry[] {
    if (ids == null) return []
    if (Array.isArray(ids)) return ids.map(id => ({ id, attributes: { ...attributes } }))
    if (typeof ids === 'object') {
      return Object.entries(ids as Record<string, Attributes>).map(([id, value]) => ({
        id: /^-?\d+$/.test(id) ? Number(id) : id,
        attributes: { ...(value ?? {}) },
      }))
    }
    return [{ id: ids, attributes: { ...attributes } }]
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

  private changed(existing: Attributes, attributes: Attributes): boolean {
    return Object.entries(attributes).some(([key, value]) => existing[key] !== value)
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
    if (!ids) return this.query(connection).get<Attributes>()
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
      const result = await this.query(connection).where(this.context.relatedColumn, 'in', ids.slice(offset, offset + this.idBatchSize())).delete()
      count += result.affectedRows ?? 0
    }
    return count
  }
}
