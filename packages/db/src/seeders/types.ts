/* v8 ignore file -- type declarations only */
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SchemaService } from '../schema/SchemaService'

export interface SeederContext {
  readonly db: DatabaseContext
  readonly schema: SchemaService
  call(...names: readonly string[]): Promise<readonly SeederDefinition[]>
}

export interface SeederDefinition {
  readonly name: string
  run(context: SeederContext): unknown | Promise<unknown>
}

export interface SeedOptions {
  only?: readonly string[]
  quietly?: boolean
  force?: boolean
  environment?: string
}
