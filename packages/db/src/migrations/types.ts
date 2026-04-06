/* v8 ignore file -- type declarations only */
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SchemaService } from '../schema/SchemaService'

export interface MigrationContext {
  readonly db: DatabaseContext
  readonly schema: SchemaService
}

export interface MigrationDefinition {
  readonly name?: string
  up(context: MigrationContext): unknown | Promise<unknown>
  down?(context: MigrationContext): unknown | Promise<unknown>
}

export interface MigrationStatus {
  readonly name: string
  readonly status: 'pending' | 'ran'
  readonly batch?: number
  readonly migratedAt?: Date
}

export interface MigrationSquashPlan {
  readonly archiveName: string
  readonly includedMigrations: readonly string[]
  readonly fromBatch?: number
  readonly toBatch?: number
  readonly ranCount: number
}

export interface MigrateOptions {
  step?: number
}

export interface RollbackOptions {
  step?: number
  batch?: number
}

export interface MigrationExecutionPolicy {
  readonly mode: 'exclusive'
  readonly scope: 'adapter'
  readonly allowsConcurrentMigrations: false
}

export type MigrationTemplateKind = 'blank' | 'create_table' | 'alter_table' | 'drop_table'

export interface MigrationTemplateOptions {
  date?: Date
  kind?: MigrationTemplateKind
  tableName?: string
}

export interface GeneratedMigrationTemplate {
  readonly fileName: string
  readonly migrationName: string
  readonly kind: MigrationTemplateKind
  readonly tableName?: string
  readonly contents: string
}
