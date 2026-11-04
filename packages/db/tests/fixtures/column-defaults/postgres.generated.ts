import { DB, column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const columnDefaultsBuilderPostgres = defineGeneratedTable("column_defaults_builder_postgres", {
  "id": column.id(),
  "word_now": column.string().default("now"),
  "word_current_timestamp": column.string().default("CURRENT_TIMESTAMP"),
  "word_null": column.string().default("null"),
  "word_true": column.string().default("true"),
  "quoted": column.string().default("it's"),
  "body": column.text().default("hello"),
  "count": column.integer().default(-3),
  "big_count": column.bigInteger().default(5000000000),
  "ratio": column.real().default(1.5),
  "balance_zero": column.decimal().default("0.00"),
  "balance": column.decimal().default("12.50"),
  "enabled": column.boolean().default(true),
  "archived": column.boolean().default(false),
  "settings": column.json().default({"a":1,"label":"it's"}),
  "status": column.enum(["draft","live"]).default("live"),
  "public_id": column.uuid().default("00000000-0000-0000-0000-000000000000"),
  "seen_at": column.timestamp().defaultNow(),
  "nickname": column.string().nullable(),
  "token": column.uuid().default(DB.raw("gen_random_uuid()")),
})

export const columnDefaultsRawPostgres = defineGeneratedTable("column_defaults_raw_postgres", {
  "id": column.id(),
  "word_now": column.string().default("now"),
  "word_current_timestamp": column.string().default("CURRENT_TIMESTAMP"),
  "word_null": column.string().default("null"),
  "word_true": column.string().default("true"),
  "digits": column.string().default("007"),
  "count": column.integer().default(-3),
  "big_count": column.bigInteger().default(5000000000),
  "ratio": column.real().default(1.5),
  "balance_zero": column.decimal().default("0.00"),
  "balance": column.decimal().default("12.50"),
  "enabled": column.boolean().default(true),
  "settings": column.json().default({"a":1}),
  "status": column.enum(["draft","live"]).default("live"),
  "seen_at": column.timestamp().defaultNow(),
  "token": column.uuid().default(DB.raw("gen_random_uuid()")),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "column_defaults_builder_postgres": typeof columnDefaultsBuilderPostgres
    "column_defaults_raw_postgres": typeof columnDefaultsRawPostgres
  }
}

export const tables = { "column_defaults_builder_postgres": columnDefaultsBuilderPostgres, "column_defaults_raw_postgres": columnDefaultsRawPostgres } as const

registerGeneratedTables(tables)
