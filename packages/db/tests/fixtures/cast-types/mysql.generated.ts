import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const castTypesMysql = defineGeneratedTable("cast_types_mysql", {
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
    "cast_types_mysql": typeof castTypesMysql
  }
}

export const tables = { "cast_types_mysql": castTypesMysql } as const

registerGeneratedTables(tables)
