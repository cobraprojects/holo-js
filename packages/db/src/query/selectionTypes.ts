import type { InferSelect, TableDefinition } from '../schema/types'

export type QualifiedTableColumns<TTable extends TableDefinition> = {
  [TColumn in keyof InferSelect<TTable> & string as `${TTable['tableName']}.${TColumn}`]: InferSelect<TTable>[TColumn]
}

export type AvailableTableColumns<TTable extends string | TableDefinition> = TTable extends TableDefinition
  ? InferSelect<TTable> & QualifiedTableColumns<TTable>
  : Record<string, unknown>

export type NullableColumns<TColumns extends Record<string, unknown>> = {
  [TColumn in keyof TColumns]: TColumns[TColumn] | null
}

export type ColumnSelection<TColumns extends Record<string, unknown>> = keyof TColumns & string
  | `${keyof TColumns & string} as ${string}`

type SelectionColumn<TSelection extends string> = TSelection extends `${infer TColumn} as ${string}` ? TColumn : TSelection

type SelectionName<TSelection extends string> = TSelection extends `${string} as ${infer TAlias}`
  ? TAlias
  : TSelection extends `${string}.${infer TColumn}` ? SelectionName<TColumn> : TSelection

export type SelectedColumns<
  TAvailableColumns extends Record<string, unknown>,
  TSelections extends readonly string[],
> = string extends TSelections[number]
  ? Record<string, unknown>
  : {
    [TSelection in TSelections[number] as SelectionName<TSelection>]: TAvailableColumns[SelectionColumn<TSelection> & keyof TAvailableColumns]
  }
