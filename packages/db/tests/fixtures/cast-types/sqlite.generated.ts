import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const castTypesLegacySqlite = defineGeneratedTable("cast_types_legacy_sqlite", {
  "id": column.id(),
  "active": column.integer().default(0),
  "settings": column.text().nullable(),
  "published_on": column.text().nullable(),
  "seen_at": column.text().nullable(),
})

export const castTypesSqlite = defineGeneratedTable("cast_types_sqlite", {
  "id": column.id(),
  "flag_int": column.integer(),
  "count_text": column.string(),
  "code_int": column.integer(),
  "meta_text": column.text(),
  "meta_json": column.text().nullable(),
  "born_on": column.string(),
  "seen_at": column.string().nullable(),
  "stamp": column.string(),
  "embedding": column.text(),
  "label": column.string(),
  "plain_json": column.text().nullable(),
  "plain_bool": column.boolean(),
  "nickname": column.string(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "cast_types_legacy_sqlite": typeof castTypesLegacySqlite
    "cast_types_sqlite": typeof castTypesSqlite
  }
}

export const tables = { "cast_types_legacy_sqlite": castTypesLegacySqlite, "cast_types_sqlite": castTypesSqlite } as const

registerGeneratedTables(tables)
