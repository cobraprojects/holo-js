import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const columnDefaultsBuilderSqlite = defineGeneratedTable("column_defaults_builder_sqlite", {
  "id": column.id(),
  "word_now": column.string().default("now"),
  "word_current_timestamp": column.string().default("CURRENT_TIMESTAMP"),
  "word_null": column.string().default("null"),
  "word_true": column.string().default("true"),
  "quoted": column.string().default("it's"),
  "body": column.text().default("hello"),
  "count": column.integer().default(-3),
  "big_count": column.integer().default(5000000000),
  "ratio": column.real().default(1.5),
  "balance_zero": column.decimal().default("0.00"),
  "balance": column.decimal().default("12.50"),
  "enabled": column.boolean().default(true),
  "archived": column.boolean().default(false),
  "settings": column.text().default("{\"a\":1,\"label\":\"it's\"}"),
  "status": column.enum(["draft","live"]).default("live"),
  "public_id": column.text().default("00000000-0000-0000-0000-000000000000"),
  "seen_at": column.datetime().defaultNow(),
  "nickname": column.string().nullable(),
})

export const columnDefaultsRawSqlite = defineGeneratedTable("column_defaults_raw_sqlite", {
  "id": column.id(),
  "word_now": column.string().default("now"),
  "bare_now": column.string().default("now"),
  "word_current_timestamp": column.string().default("CURRENT_TIMESTAMP"),
  "word_null": column.string().default("null"),
  "word_true": column.string().default("true"),
  "digits": column.string().default("007"),
  "count": column.integer().default(-3),
  "ratio": column.real().default(1.5),
  "balance_zero": column.decimal().default("0.00"),
  "balance": column.decimal().default("12.50"),
  "enabled": column.boolean().default(true),
  "settings": column.text().default("{\"a\":1}"),
  "status": column.enum(["draft","live"]).default("live"),
  "seen_at": column.datetime().defaultNow(),
  "token": column.text().default("lower(hex(randomblob(4)))"),
  "missing": column.text().nullable().default(null),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "column_defaults_builder_sqlite": typeof columnDefaultsBuilderSqlite
    "column_defaults_raw_sqlite": typeof columnDefaultsRawSqlite
  }
}

export const tables = { "column_defaults_builder_sqlite": columnDefaultsBuilderSqlite, "column_defaults_raw_sqlite": columnDefaultsRawSqlite } as const

registerGeneratedTables(tables)
