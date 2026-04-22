import { afterEach, describe, expect, it } from 'vitest'
import {
  clearGeneratedTables,
  column,
  defineGeneratedTable,
  getGeneratedTableDefinition,
  listGeneratedTableDefinitions,
  registerGeneratedTables,
  resolveGeneratedTableDefinition,
  renderGeneratedSchemaModule,
  renderGeneratedSchemaPlaceholder,
  type TableDefinition,
} from '../src'

afterEach(() => {
  clearGeneratedTables()
})

describe('generated schema helpers', () => {
  it('registers, resolves, lists, and clears generated tables', () => {
    const users = defineGeneratedTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineGeneratedTable('posts', {
      id: column.id(),
      user_id: column.foreignId().constrained('users'),
      title: column.string(),
    })

    const registered = registerGeneratedTables({ posts, users })

    expect(registered).toEqual({ posts, users })
    expect(getGeneratedTableDefinition('users')).toBe(users)
    expect(getGeneratedTableDefinition('posts')).toBe(posts)
    expect(listGeneratedTableDefinitions().map(table => table.tableName)).toEqual(['posts', 'users'])

    clearGeneratedTables()

    expect(getGeneratedTableDefinition('users')).toBeUndefined()
    expect(listGeneratedTableDefinitions()).toEqual([])
  })

  it('renders placeholder and full generated schema modules for every supported column family', () => {
    const auditEvents = defineGeneratedTable('audit.events', {
      id: column.id(),
      account_id: column.foreignId().constraintName('audit_events_account_fk').constrained('accounts').cascadeOnDelete().restrictOnUpdate(),
      integer_value: column.integer().default(7),
      big_integer_value: column.bigInteger(),
      string_value: column.string().unique(),
      text_value: column.text(),
      boolean_value: column.boolean().default(false),
      real_value: column.real().default(1.5),
      decimal_value: column.decimal().default('12.34'),
      date_value: column.date(),
      datetime_value: column.datetime().default(new Date('2026-03-30T00:00:00.000Z')),
      timestamp_value: column.timestamp().defaultNow(),
      json_value: column.json<{ enabled: boolean }>().default({ enabled: true }),
      blob_value: column.blob(),
      uuid_value: column.uuid(),
      owner_uuid: column.foreignUuid().constrained('owners', 'uuid'),
      ulid_value: column.ulid(),
      session_ulid: column.foreignUlid().constrained('sessions'),
      snowflake_value: column.snowflake(),
      actor_snowflake: column.foreignSnowflake().constrained('actors', 'snowflake_id'),
      vector_value: column.vector({ dimensions: 3 }),
      enum_value: column.enum(['draft', 'published'] as const).default('draft'),
      nullable_value: column.string().nullable(),
      generated_value: column.string().generated(),
      public_uuid: column.uuid().primaryKey(),
    }, {
      indexes: [
        { columns: ['string_value'], unique: false },
        { columns: ['account_id', 'string_value'], unique: true, name: 'audit_events_account_string_unique' },
      ],
    })

    const blankIdentifierTable = {
      tableName: '---',
      columns: {
        maybe: {
          ...auditEvents.columns.string_value,
          name: 'maybe',
          hasDefault: true,
          defaultKind: 'value',
          defaultValue: Symbol('missing-default'),
          unique: false,
        },
      },
      indexes: [],
    } as unknown as TableDefinition

    const numberedTable = {
      tableName: '123-weird-table',
      columns: {
        nullable_note: {
          ...auditEvents.columns.nullable_value,
          name: 'nullable_note',
          hasDefault: true,
          defaultKind: 'value',
          defaultValue: null,
        },
      },
      indexes: [],
    } as unknown as TableDefinition

    const fallbackKindsTable = {
      tableName: 'fallback-kinds',
      columns: {
        vector_value: {
          ...auditEvents.columns.vector_value,
          name: 'vector_value',
          vectorDimensions: undefined,
        },
        enum_value: {
          ...auditEvents.columns.enum_value,
          name: 'enum_value',
          enumValues: undefined,
        },
      },
      indexes: [],
    } as unknown as TableDefinition

    const placeholder = renderGeneratedSchemaPlaceholder()
    expect(placeholder).toContain('interface GeneratedSchemaTables {}')
    expect(placeholder).toContain('registerGeneratedTables(tables)')

    const rendered = renderGeneratedSchemaModule([numberedTable, auditEvents, blankIdentifierTable, fallbackKindsTable])

    expect(rendered).toContain('import { column, defineGeneratedTable, registerGeneratedTables } from \'@holo-js/db\'')
    expect(rendered).toContain('export const auditEvents = defineGeneratedTable("audit.events", {')
    expect(rendered).toContain('export const table = defineGeneratedTable("---", {')
    expect(rendered).toContain('export const table123WeirdTable = defineGeneratedTable("123-weird-table", {')
    expect(rendered).toContain('"account_id": column.foreignId().constrained("accounts").constraintName("audit_events_account_fk").onDelete("cascade").onUpdate("restrict"),')
    expect(rendered).toContain('"integer_value": column.integer().default(7),')
    expect(rendered).toContain('"big_integer_value": column.bigInteger(),')
    expect(rendered).toContain('"string_value": column.string().unique(),')
    expect(rendered).toContain('"text_value": column.text(),')
    expect(rendered).toContain('"boolean_value": column.boolean().default(false),')
    expect(rendered).toContain('"real_value": column.real().default(1.5),')
    expect(rendered).toContain('"decimal_value": column.decimal().default("12.34"),')
    expect(rendered).toContain('"date_value": column.date(),')
    expect(rendered).toContain('"datetime_value": column.datetime().default(new Date("2026-03-30T00:00:00.000Z")),')
    expect(rendered).toContain('"timestamp_value": column.timestamp().defaultNow(),')
    expect(rendered).toContain('"json_value": column.json().default({"enabled":true}),')
    expect(rendered).toContain('"blob_value": column.blob(),')
    expect(rendered).toContain('"uuid_value": column.uuid(),')
    expect(rendered).toContain('"owner_uuid": column.foreignUuid().constrained("owners", "uuid"),')
    expect(rendered).toContain('"ulid_value": column.ulid(),')
    expect(rendered).toContain('"session_ulid": column.foreignUlid().constrained("sessions"),')
    expect(rendered).toContain('"snowflake_value": column.snowflake(),')
    expect(rendered).toContain('"actor_snowflake": column.foreignSnowflake().constrained("actors", "snowflake_id"),')
    expect(rendered).toContain('"vector_value": column.vector({ dimensions: 3 }),')
    expect(rendered).toContain('"enum_value": column.enum(["draft","published"]).default("draft"),')
    expect(rendered).toContain('"nullable_value": column.string().nullable(),')
    expect(rendered).toContain('"generated_value": column.string().generated(),')
    expect(rendered).toContain('"public_uuid": column.uuid().primaryKey(),')
    expect(rendered).toContain('"maybe": column.string().default(undefined),')
    expect(rendered).toContain('"nullable_note": column.string().nullable().default(null),')
    expect(rendered).toContain('"vector_value": column.vector({ dimensions: 0 }),')
    expect(rendered).toContain('"enum_value": column.enum([]).default("draft"),')
    expect(rendered).toContain('{ columns: ["string_value"], unique: false }')
    expect(rendered).toContain('{ columns: ["account_id","string_value"], unique: true, name: "audit_events_account_string_unique" }')
    expect(rendered).toContain('"audit.events": typeof auditEvents')
    expect(rendered).toContain('"---": typeof table')
    expect(rendered).toContain('"123-weird-table": typeof table123WeirdTable')
    expect(rendered).toContain('declare module \'@holo-js/db\' {')
    expect(rendered).toContain('export const tables = { ')
    expect(rendered).toContain('registerGeneratedTables(tables)')
    expect(rendered).not.toContain('@holo-js/db/src/')
    expect(rendered).not.toContain('../node_modules/@holo-js/db/src/')
  })

  it('resolves explicit generated tables and falls back to a minimal table shape when absent', () => {
    const users = defineGeneratedTable('users', {
      id: column.id(),
      name: column.string(),
    })

    expect(resolveGeneratedTableDefinition('users', { users })).toBe(users)

    const fallback = resolveGeneratedTableDefinition('missing_users', {})
    expect(fallback.tableName).toBe('missing_users')
    expect(Object.keys(fallback.columns)).toEqual(['id'])
    expect(fallback.columns.id?.kind).toBe('id')
  })
})
