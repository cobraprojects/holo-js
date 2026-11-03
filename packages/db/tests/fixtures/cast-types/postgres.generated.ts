import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const castTypesPostgres = defineGeneratedTable("cast_types_postgres", {
  "id": column.id(),
  "flag_int": column.integer(),
  "count_text": column.string(),
  "code_int": column.integer(),
  "meta_text": column.text(),
  "meta_json": column.json().nullable(),
  "born_on": column.string(),
  "seen_at": column.string().nullable(),
  "stamp": column.string(),
  "embedding": column.text(),
  "label": column.string(),
  "plain_json": column.json().nullable(),
  "plain_bool": column.boolean(),
  "nickname": column.string(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "cast_types_postgres": typeof castTypesPostgres
  }
}

export const tables = { "cast_types_postgres": castTypesPostgres } as const

registerGeneratedTables(tables)
