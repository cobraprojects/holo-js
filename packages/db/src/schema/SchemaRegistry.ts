import { SchemaError } from '../core/errors'
import type { TableDefinition } from './types'

export class SchemaRegistry {
  private readonly tables = new Map<string, TableDefinition>()

  register<TTable extends TableDefinition>(table: TTable): TTable {
    const existing = this.tables.get(table.tableName)
    if (existing && existing !== table) {
      throw new SchemaError(`Table "${table.tableName}" is already registered in this SchemaRegistry.`)
    }

    this.tables.set(table.tableName, table)
    return table
  }

  has(name: string): boolean {
    return this.tables.has(name)
  }

  replace<TTable extends TableDefinition>(table: TTable): TTable {
    this.tables.set(table.tableName, table)
    return table
  }

  delete(name: string): void {
    this.tables.delete(name)
  }

  get<TTable extends TableDefinition = TableDefinition>(name: string): TTable | undefined {
    return this.tables.get(name) as TTable | undefined
  }

  list(): TableDefinition[] {
    return [...this.tables.values()]
  }

  clear(): void {
    this.tables.clear()
  }
}

export function createSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry()
}
