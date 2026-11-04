import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const computedBuilderPostgres = defineGeneratedTable("computed_builder_postgres", {
  "id": column.id(),
  "price": column.integer(),
  "quantity": column.integer(),
  "name": column.string(),
  "note": column.string().nullable(),
  "total": column.integer().storedAs("(price * quantity)"),
  "label": column.string().storedAs("((name)::text || ' (it''s)'::text)"),
})

export const computedRawPostgres = defineGeneratedTable("computed_raw_postgres", {
  "id": column.id(),
  "width": column.integer(),
  "height": column.integer(),
  "area": column.integer().storedAs("(width * height)"),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "computed_builder_postgres": typeof computedBuilderPostgres
    "computed_raw_postgres": typeof computedRawPostgres
  }
}

export const tables = { "computed_builder_postgres": computedBuilderPostgres, "computed_raw_postgres": computedRawPostgres } as const

registerGeneratedTables(tables)
