import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, SchemaError, column, holoRuntimeInternals, renderGeneratedSchemaModule, type AnyColumnDefinition, type TableDefinition } from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

type ReadDefault = 'none' | 'now' | { value: unknown } | { expression: unknown }

function readDefaults(table: TableDefinition): Record<string, { kind: string, default: ReadDefault }> {
  return Object.fromEntries(Object.values(table.columns).map((column: AnyColumnDefinition) => [column.name, {
    kind: column.kind,
    default: !column.hasDefault
      ? 'none'
      : column.defaultKind === 'now'
        ? 'now'
        : column.defaultKind === 'expression' ? { expression: column.defaultValue } : { value: column.defaultValue },
  }]))
}

const rawTables = {
  sqlite: (name: string) => `CREATE TABLE "${name}" (
    "id" integer PRIMARY KEY,
    "word_now" varchar(20) NOT NULL DEFAULT 'now',
    "bare_now" varchar(20) NOT NULL DEFAULT now,
    "word_current_timestamp" varchar(20) NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
    "word_null" varchar(20) NOT NULL DEFAULT 'null',
    "word_true" varchar(20) NOT NULL DEFAULT 'true',
    "digits" varchar(20) NOT NULL DEFAULT '007',
    "count" integer NOT NULL DEFAULT -3,
    "ratio" real NOT NULL DEFAULT 1.5,
    "balance_zero" numeric NOT NULL DEFAULT 0.00,
    "balance" numeric NOT NULL DEFAULT '12.50',
    "enabled" tinyint(1) NOT NULL DEFAULT TRUE,
    "settings" text NOT NULL DEFAULT '{"a":1}',
    "status" varchar(10) NOT NULL DEFAULT 'live' CHECK ("status" IN ('draft', 'live')),
    "seen_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" text NOT NULL DEFAULT (lower(hex(randomblob(4)))),
    "missing" text DEFAULT NULL
  )`,
  postgres: (name: string) => `CREATE TABLE "${name}" (
    "id" serial PRIMARY KEY,
    "word_now" varchar(20) NOT NULL DEFAULT 'now',
    "word_current_timestamp" varchar(20) NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
    "word_null" varchar(20) NOT NULL DEFAULT 'null',
    "word_true" varchar(20) NOT NULL DEFAULT 'true',
    "digits" varchar(20) NOT NULL DEFAULT '007',
    "count" integer NOT NULL DEFAULT -3,
    "big_count" bigint NOT NULL DEFAULT 5000000000,
    "ratio" double precision NOT NULL DEFAULT 1.5,
    "balance_zero" numeric(8, 2) NOT NULL DEFAULT 0.00,
    "balance" numeric(8, 2) NOT NULL DEFAULT '12.50',
    "enabled" boolean NOT NULL DEFAULT true,
    "settings" jsonb NOT NULL DEFAULT '{"a":1}',
    "status" varchar(10) NOT NULL DEFAULT 'live' CHECK ("status" IN ('draft', 'live')),
    "seen_at" timestamp NOT NULL DEFAULT now(),
    "token" uuid NOT NULL DEFAULT gen_random_uuid()
  )`,
  mysql: (name: string) => `CREATE TABLE \`${name}\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`word_now\` varchar(20) NOT NULL DEFAULT 'now',
    \`word_current_timestamp\` varchar(20) NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
    \`word_null\` varchar(20) NOT NULL DEFAULT 'null',
    \`word_true\` varchar(20) NOT NULL DEFAULT 'true',
    \`digits\` varchar(20) NOT NULL DEFAULT '007',
    \`count\` int NOT NULL DEFAULT -3,
    \`big_count\` bigint NOT NULL DEFAULT 5000000000,
    \`ratio\` double NOT NULL DEFAULT 1.5,
    \`balance_zero\` decimal(8, 2) NOT NULL DEFAULT 0.00,
    \`balance\` decimal(8, 2) NOT NULL DEFAULT '12.50',
    \`enabled\` tinyint(1) NOT NULL DEFAULT 1,
    \`settings\` json NOT NULL DEFAULT ('{"a":"it''s \\\\\\\\ fine"}'),
    \`note\` text NOT NULL DEFAULT ('it''s'),
    \`status\` enum('draft', 'live') NOT NULL DEFAULT 'live',
    \`seen_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    \`seen_at_ms\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    \`token\` varchar(40) NOT NULL DEFAULT (concat('t-', uuid()))
  )`,
} as const

const builderKinds = {
  sqlite: { bigInteger: 'integer', uuid: 'text', settings: 'text', seenAt: 'datetime' },
  postgres: { bigInteger: 'bigInteger', uuid: 'uuid', settings: 'json', seenAt: 'timestamp' },
  mysql: { bigInteger: 'bigInteger', uuid: 'uuid', settings: 'json', seenAt: 'timestamp' },
} as const

const uuidExpressions = {
  sqlite: 'lower(hex(randomblob(16)))',
  postgres: 'gen_random_uuid()',
  mysql: 'uuid()',
} as const

const jsonDefaults: Record<string, unknown> = {
  json_string: 'hello',
  json_numeric_string: '123',
  json_quoted: 'it\'s \\ "q"',
  json_number: 42,
  json_negative: -1.5,
  json_true: true,
  json_false: false,
  json_object: { a: 1, nested: { b: [true, null], label: 'it\'s' } },
  json_array: [1, 'two', { three: 3 }],
  json_empty_object: {},
}

function decodeJson(driver: 'sqlite' | 'postgres' | 'mysql', value: unknown): unknown {
  return driver === 'sqlite' && typeof value === 'string' ? JSON.parse(value) as unknown : value
}

const UUID_LIKE = /^[0-9a-f-]{32,36}$/

describe('expression column defaults', () => {
  it('stores a DB.raw statement as an expression default', () => {
    const definition = column.uuid().default(DB.raw('gen_random_uuid()')).toDefinition({ name: 'token' })

    expect(definition).toMatchObject({ hasDefault: true, defaultKind: 'expression', defaultValue: 'gen_random_uuid()' })
  })

  it('rejects a DB.raw statement with bindings or empty SQL', () => {
    expect(() => column.string().default(DB.raw('concat(?, uuid())', ['t-']))).toThrow(SchemaError)
    expect(() => column.string().default(DB.raw('  '))).toThrow(SchemaError)
  })

  it('keeps objects that only look like DB.raw statements as validated values', () => {
    const lookalike = { unsafe: true, sql: 'uuid()', bindings: [] }
    const copied = { ...DB.raw('uuid()') }

    expect(column.json().default(lookalike).toDefinition({ name: 'settings' })).toMatchObject({ defaultKind: 'value', defaultValue: lookalike })
    expect(column.json().default(copied).toDefinition({ name: 'settings' })).toMatchObject({ defaultKind: 'value' })
  })
})

const expectedRawDefaults = {
  sqlite: {
    id: { kind: 'id', default: 'none' },
    word_now: { kind: 'string', default: { value: 'now' } },
    bare_now: { kind: 'string', default: { value: 'now' } },
    word_current_timestamp: { kind: 'string', default: { value: 'CURRENT_TIMESTAMP' } },
    word_null: { kind: 'string', default: { value: 'null' } },
    word_true: { kind: 'string', default: { value: 'true' } },
    digits: { kind: 'string', default: { value: '007' } },
    count: { kind: 'integer', default: { value: -3 } },
    ratio: { kind: 'real', default: { value: 1.5 } },
    balance_zero: { kind: 'decimal', default: { value: '0.00' } },
    balance: { kind: 'decimal', default: { value: '12.50' } },
    enabled: { kind: 'boolean', default: { value: true } },
    settings: { kind: 'text', default: { value: '{"a":1}' } },
    status: { kind: 'enum', default: { value: 'live' } },
    seen_at: { kind: 'datetime', default: 'now' },
    token: { kind: 'text', default: { expression: 'lower(hex(randomblob(4)))' } },
    missing: { kind: 'text', default: { value: null } },
  },
  postgres: {
    id: { kind: 'id', default: 'none' },
    word_now: { kind: 'string', default: { value: 'now' } },
    word_current_timestamp: { kind: 'string', default: { value: 'CURRENT_TIMESTAMP' } },
    word_null: { kind: 'string', default: { value: 'null' } },
    word_true: { kind: 'string', default: { value: 'true' } },
    digits: { kind: 'string', default: { value: '007' } },
    count: { kind: 'integer', default: { value: -3 } },
    big_count: { kind: 'bigInteger', default: { value: 5000000000 } },
    ratio: { kind: 'real', default: { value: 1.5 } },
    balance_zero: { kind: 'decimal', default: { value: '0.00' } },
    balance: { kind: 'decimal', default: { value: '12.50' } },
    enabled: { kind: 'boolean', default: { value: true } },
    settings: { kind: 'json', default: { value: { a: 1 } } },
    status: { kind: 'enum', default: { value: 'live' } },
    seen_at: { kind: 'timestamp', default: 'now' },
    token: { kind: 'uuid', default: { expression: 'gen_random_uuid()' } },
  },
  mysql: {
    id: { kind: 'id', default: 'none' },
    word_now: { kind: 'string', default: { value: 'now' } },
    word_current_timestamp: { kind: 'string', default: { value: 'CURRENT_TIMESTAMP' } },
    word_null: { kind: 'string', default: { value: 'null' } },
    word_true: { kind: 'string', default: { value: 'true' } },
    digits: { kind: 'string', default: { value: '007' } },
    count: { kind: 'integer', default: { value: -3 } },
    big_count: { kind: 'bigInteger', default: { value: 5000000000 } },
    ratio: { kind: 'real', default: { value: 1.5 } },
    balance_zero: { kind: 'decimal', default: { value: '0.00' } },
    balance: { kind: 'decimal', default: { value: '12.50' } },
    enabled: { kind: 'boolean', default: { value: true } },
    settings: { kind: 'json', default: { value: { a: 'it\'s \\ fine' } } },
    note: { kind: 'text', default: { value: 'it\'s' } },
    status: { kind: 'enum', default: { value: 'live' } },
    seen_at: { kind: 'timestamp', default: 'now' },
    seen_at_ms: { kind: 'datetime', default: 'now' },
    token: { kind: 'string', default: { expression: 'concat(_utf8mb4\'t-\',uuid())' } },
  },
} as const

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`${driver} column defaults in the Generated schema`, () => {
    const builderTable = `column_defaults_builder_${driver}`
    const rawTable = `column_defaults_raw_${driver}`

    async function openDefaultsDatabase() {
      const { db, schema } = await openDatabase(driver)
      for (const name of [builderTable, rawTable]) {
        await schema.dropTable(name)
        onTestFinished(() => schema.dropTable(name))
      }
      await schema.createTable(builderTable, (table) => {
        table.id()
        table.string('word_now').default('now')
        table.string('word_current_timestamp').default('CURRENT_TIMESTAMP')
        table.string('word_null').default('null')
        table.string('word_true').default('true')
        table.string('quoted').default('it\'s')
        table.text('body').default('hello')
        table.integer('count').default(-3)
        table.bigInteger('big_count').default(5000000000)
        table.real('ratio').default(1.5)
        table.decimal('balance_zero').default('0.00')
        table.decimal('balance').default('12.50')
        table.boolean('enabled').default(true)
        table.boolean('archived').default(false)
        table.json('settings').default({ a: 1, label: 'it\'s' })
        table.enum('status', ['draft', 'live'] as const).default('live')
        table.uuid('public_id').default('00000000-0000-0000-0000-000000000000')
        table.timestamp('seen_at').defaultNow()
        table.string('nickname').nullable()
        table.uuid('token').default(DB.raw(uuidExpressions[driver]))
      })
      await db.executeCompiled({ sql: rawTables[driver](rawTable), source: 'test:column-defaults' })
      const reader = createSchemaReader(db)
      const tables = [(await reader.readTable(builderTable))!, (await reader.readTable(rawTable))!]
      return { db, tables }
    }

    it('reads each schema builder default as a literal of its column type or as now', async () => {
      const { tables: [builder] } = await openDefaultsDatabase()
      const kinds = builderKinds[driver]

      expect(readDefaults(builder!)).toEqual({
        id: { kind: 'id', default: 'none' },
        word_now: { kind: 'string', default: { value: 'now' } },
        word_current_timestamp: { kind: 'string', default: { value: 'CURRENT_TIMESTAMP' } },
        word_null: { kind: 'string', default: { value: 'null' } },
        word_true: { kind: 'string', default: { value: 'true' } },
        quoted: { kind: 'string', default: { value: 'it\'s' } },
        body: { kind: 'text', default: { value: 'hello' } },
        count: { kind: 'integer', default: { value: -3 } },
        big_count: { kind: kinds.bigInteger, default: { value: 5000000000 } },
        ratio: { kind: 'real', default: { value: 1.5 } },
        balance_zero: { kind: 'decimal', default: { value: '0.00' } },
        balance: { kind: 'decimal', default: { value: '12.50' } },
        enabled: { kind: 'boolean', default: { value: true } },
        archived: { kind: 'boolean', default: { value: false } },
        settings: {
          kind: kinds.settings,
          default: { value: kinds.settings === 'json' ? { a: 1, label: 'it\'s' } : '{"a":1,"label":"it\'s"}' },
        },
        status: { kind: 'enum', default: { value: 'live' } },
        public_id: { kind: kinds.uuid, default: { value: '00000000-0000-0000-0000-000000000000' } },
        seen_at: { kind: kinds.seenAt, default: 'now' },
        nickname: { kind: 'string', default: 'none' },
        token: { kind: kinds.uuid, default: { expression: uuidExpressions[driver] } },
      })
    })

    it('fills a DB.raw default from the database expression on insert', async () => {
      const { db } = await openDefaultsDatabase()

      await db.table(builderTable).insert({ nickname: 'a' })
      await db.table(builderTable).insert({ nickname: 'b' })
      const tokens = (await db.table(builderTable).select('token').get()).map(row => (row as { token: string }).token)

      expect(tokens).toHaveLength(2)
      expect(tokens.every(token => UUID_LIKE.test(token))).toBe(true)
      expect(new Set(tokens).size).toBe(2)
    })

    it.skipIf(driver === 'mysql')('adds a DB.raw default column to a table that has rows', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `column_defaults_add_${driver}`
      await schema.dropTable(name)
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.id()
        table.string('label')
      })
      await db.table(name).insert({ label: 'a' })

      await schema.table(name, (table) => {
        table.uuid('token').default(DB.raw(uuidExpressions[driver]))
      })
      await db.table(name).insert({ label: 'b' })

      const tokens = (await db.table(name).select('token').get()).map(row => (row as { token: string }).token)
      expect(tokens).toHaveLength(2)
      expect(tokens.every(token => UUID_LIKE.test(token))).toBe(true)
      expect(new Set(tokens).size).toBe(2)
    })

    it('changes a column to a DB.raw default', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `column_defaults_change_${driver}`
      await schema.dropTable(name)
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.id()
        table.uuid('token').nullable()
        table.string('label')
      })

      await schema.table(name, (table) => {
        table.uuid('token').default(DB.raw(uuidExpressions[driver])).change()
      })
      await db.table(name).insert({ label: 'a' })

      const [row] = await db.table(name).select('token').get() as Array<{ token: string }>
      expect(row!.token).toMatch(UUID_LIKE)
      expect(readDefaults((await createSchemaReader(db).readTable(name))!).token).toEqual({
        kind: builderKinds[driver].uuid,
        default: { expression: uuidExpressions[driver] },
      })
    })

    it('reads raw DDL defaults as literals of their column type, now, or the database expression', async () => {
      const { tables: [, raw] } = await openDefaultsDatabase()

      expect(readDefaults(raw!)).toEqual(expectedRawDefaults[driver])
    })

    it('migrates JSON literal defaults and reads each back as the same JSON value', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `column_defaults_json_${driver}`
      await schema.dropTable(name)
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.id()
        table.string('label')
        for (const [columnName, value] of Object.entries(jsonDefaults)) {
          table.json(columnName).default(value)
        }
        table.json('json_null').nullable().default(null)
      })
      await db.table(name).insert({ label: 'a' })

      const [row] = await db.table(name).get() as Array<Record<string, unknown>>
      const definition = (await createSchemaReader(db).readTable(name))!
      const read = readDefaults(definition)
      const rendered = await renderGeneratedSchemaModule([definition])
      for (const [columnName, value] of Object.entries(jsonDefaults)) {
        expect(decodeJson(driver, row![columnName])).toEqual(value)
        expect(rendered).toContain(builderKinds[driver].settings === 'json'
          ? `"${columnName}": column.json().default(${JSON.stringify(value)}),`
          : `"${columnName}": column.text().default(${JSON.stringify(JSON.stringify(value))}),`)
        expect(read[columnName]).toEqual(builderKinds[driver].settings === 'json'
          ? { kind: 'json', default: { value } }
          : { kind: 'text', default: { value: JSON.stringify(value) } })
      }
      expect(row!.json_null).toBeNull()
      expect(read.json_null).toEqual({ kind: builderKinds[driver].settings, default: driver === 'sqlite' ? { value: null } : 'none' })
    })

    it('changes a JSON column default to a JSON literal', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `column_defaults_json_change_${driver}`
      await schema.dropTable(name)
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.id()
        table.string('label')
        table.json('meta').nullable()
      })

      await schema.table(name, (table) => {
        table.json('meta').default('hello').change()
      })
      await db.table(name).insert({ label: 'a' })

      const [row] = await db.table(name).select('meta').get() as Array<{ meta: unknown }>
      expect(decodeJson(driver, row!.meta)).toBe('hello')
      expect(readDefaults((await createSchemaReader(db).readTable(name))!).meta).toEqual(builderKinds[driver].settings === 'json'
        ? { kind: 'json', default: { value: 'hello' } }
        : { kind: 'text', default: { value: '"hello"' } })
    })

    it('writes a Generated schema module with those defaults that the type tests compile', async () => {
      const { tables } = await openDefaultsDatabase()

      await expect(renderGeneratedSchemaModule(tables)).toMatchFileSnapshot(`./fixtures/column-defaults/${driver}.generated.ts`)
    })
  })
}
