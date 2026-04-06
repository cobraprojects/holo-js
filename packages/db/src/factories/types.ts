/* v8 ignore file -- type declarations only */
import type { ModelRecord } from '../model/types'
import type { TableDefinition } from '../schema/types'

export interface FactoryEntityReference<TTable extends TableDefinition = TableDefinition> {
  attach(relation: string, ids: unknown, attributes?: Record<string, unknown>): Promise<void>
  exists(): boolean
  get(key: Extract<keyof ModelRecord<TTable>, string>): ModelRecord<TTable>[Extract<keyof ModelRecord<TTable>, string>]
  set(
    key: Extract<keyof ModelRecord<TTable>, string>,
    value: ModelRecord<TTable>[Extract<keyof ModelRecord<TTable>, string>],
  ): FactoryEntityReference<TTable>
  getRelation(name: string): unknown
  hasRelation(name: string): boolean
  setRelation(name: string, value: unknown): FactoryEntityReference<TTable>
  toAttributes(): Record<string, unknown>
  getRepository(): unknown
}

export interface FactoryModelReference<TTable extends TableDefinition = TableDefinition> {
  readonly definition: { table: TTable, morphClass?: string }
  getRepository(): unknown
  make(values?: Partial<ModelRecord<TTable>>): FactoryEntityReference<TTable>
  create(values?: Partial<ModelRecord<TTable>>): Promise<FactoryEntityReference<TTable>>
  getConnectionName?(): string | undefined
}

export interface FactoryContext<TModel extends FactoryModelReference = FactoryModelReference> {
  readonly sequence: number
  readonly model: TModel
}

export type FactoryAttributes<TModel extends FactoryModelReference>
  = Partial<ModelRecord<TModel['definition']['table']>>

export type FactoryDefinition<TModel extends FactoryModelReference> = (
  context: FactoryContext<TModel>,
) => FactoryAttributes<TModel> | Promise<FactoryAttributes<TModel>>

export type FactoryStateDefinition<TModel extends FactoryModelReference>
  = | FactoryAttributes<TModel>
    | ((
      attributes: FactoryAttributes<TModel>,
      context: FactoryContext<TModel>,
    ) => FactoryAttributes<TModel> | Promise<FactoryAttributes<TModel>>)

export type FactoryHook<TModel extends FactoryModelReference> = (
  entity: FactoryEntityReference<TModel['definition']['table']>,
  context: FactoryContext<TModel>,
) => void | Promise<void>
