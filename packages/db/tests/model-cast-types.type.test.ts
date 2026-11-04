import { expectTypeOf, it } from 'vitest'
import { binaryCast, defineModel, encryptedCast, type ModelCastDefinition, type VectorValue } from '../src'
import type {} from './fixtures/cast-types/sqlite.generated'
import type {} from './fixtures/cast-types/postgres.generated'
import type {} from './fixtures/cast-types/mysql.generated'

type Attributes<TModel extends { findOrFail(id: number): Promise<object> }> = Awaited<ReturnType<TModel['findOrFail']>>
type Flat<TValue> = { [K in keyof TValue]: TValue[K] }
type InsertPayload<TModel extends { create(...args: never[]): unknown }> = Flat<Parameters<TModel['create']>[0]>
type MakePayload<TModel extends { make(...args: never[]): unknown }> = NonNullable<Parameters<TModel['make']>[0]>
type UpdatePayload<TModel extends { update(...args: never[]): unknown }> = Parameters<TModel['update']>[1]

const builtInCasts = {
  flag_int: 'boolean',
  count_text: 'number',
  code_int: 'string',
  meta_text: 'json',
  meta_json: 'json',
  born_on: 'date',
  seen_at: 'datetime',
  stamp: 'timestamp',
  embedding: 'vector:3',
  label: { get: (value: unknown) => String(value), set: (value: unknown) => String(value) },
  appended_total: 'number',
} as const

const sqliteModel = defineModel('cast_types_sqlite', { casts: builtInCasts })
const postgresModel = defineModel('cast_types_postgres', { casts: builtInCasts })
const mysqlModel = defineModel('cast_types_mysql', { casts: builtInCasts })

it('types each built-in cast over a Generated schema read from SQLite, PostgreSQL and MySQL', () => {
  for (const model of [sqliteModel, postgresModel, mysqlModel]) {
    type Record = Attributes<typeof model>
    expectTypeOf<Record['flag_int']>().toEqualTypeOf<boolean>()
    expectTypeOf<Record['count_text']>().toEqualTypeOf<number>()
    expectTypeOf<Record['code_int']>().toEqualTypeOf<string>()
    expectTypeOf<Record['meta_text']>().toEqualTypeOf<unknown>()
    expectTypeOf<Record['meta_json']>().toEqualTypeOf<unknown>()
    expectTypeOf<Record['born_on']>().toEqualTypeOf<Date>()
    expectTypeOf<Record['seen_at']>().toEqualTypeOf<Date | null>()
    expectTypeOf<Record['stamp']>().toEqualTypeOf<Date>()
    expectTypeOf<Record['embedding']>().toEqualTypeOf<VectorValue>()
    expectTypeOf<Record['label']>().toEqualTypeOf<string>()
    expectTypeOf<Record['plain_bool']>().toEqualTypeOf<boolean>()
    expectTypeOf<Record['nickname']>().toEqualTypeOf<string>()
    expectTypeOf<Record>().not.toHaveProperty('appended_total')
  }
})

it('keeps the database-derived type of a column without a cast', () => {
  expectTypeOf<Attributes<typeof sqliteModel>['plain_json']>().toEqualTypeOf<string | null>()
  expectTypeOf<Attributes<typeof postgresModel>['plain_json']>().toEqualTypeOf<unknown>()
  expectTypeOf<Attributes<typeof mysqlModel>['plain_json']>().toEqualTypeOf<unknown>()
  const Uncast = defineModel('cast_types_sqlite')
  const untypedCasts: Record<string, ModelCastDefinition> = { flag_int: 'boolean' }
  const UntypedCasts = defineModel('cast_types_sqlite', { casts: untypedCasts })
  expectTypeOf<Attributes<typeof Uncast>['flag_int']>().toEqualTypeOf<number>()
  expectTypeOf<Attributes<typeof UntypedCasts>['flag_int']>().toEqualTypeOf<number>()
})

it('accepts the cast types when creating and updating', () => {
  expectTypeOf<InsertPayload<typeof sqliteModel>>().toEqualTypeOf<{
    id?: number
    flag_int?: boolean
    count_text?: number
    code_int?: string
    meta_text?: unknown
    meta_json?: unknown
    born_on?: Date
    seen_at?: Date | null
    stamp?: Date
    embedding?: VectorValue
    label?: string
    plain_json?: string | null
    plain_bool?: boolean
    nickname?: string
  }>()
  for (const model of [postgresModel, mysqlModel]) {
    expectTypeOf<InsertPayload<typeof model>>().toHaveProperty('flag_int').toEqualTypeOf<boolean | undefined>()
    expectTypeOf<InsertPayload<typeof model>>().toHaveProperty('born_on').toEqualTypeOf<Date | undefined>()
    expectTypeOf<InsertPayload<typeof model>>().toHaveProperty('embedding').toEqualTypeOf<VectorValue | undefined>()
  }
  for (const model of [sqliteModel, postgresModel, mysqlModel]) {
    expectTypeOf<UpdatePayload<typeof model>>().toHaveProperty('flag_int').toEqualTypeOf<boolean | undefined>()
    expectTypeOf<UpdatePayload<typeof model>>().toHaveProperty('seen_at').toEqualTypeOf<Date | null | undefined>()
  }
})

it('restores boolean, JSON and date types on SQLite columns created before the upgrade', () => {
  const Legacy = defineModel('cast_types_legacy_sqlite', {
    casts: { active: 'boolean', settings: 'json', published_on: 'date', seen_at: 'datetime' },
    fillable: ['active', 'settings', 'published_on', 'seen_at'],
    pendingAttributes: { active: true, published_on: new Date() },
  })
  type Record = Attributes<typeof Legacy>

  expectTypeOf<Record['active']>().toEqualTypeOf<boolean>()
  expectTypeOf<Record['settings']>().toEqualTypeOf<unknown>()
  expectTypeOf<Record['published_on']>().toEqualTypeOf<Date | null>()
  expectTypeOf<Record['seen_at']>().toEqualTypeOf<Date | null>()
  expectTypeOf<MakePayload<typeof Legacy>>().toHaveProperty('active').toEqualTypeOf<boolean | undefined>()
  expectTypeOf<MakePayload<typeof Legacy>>().toHaveProperty('published_on').toEqualTypeOf<Date | null | undefined>()
})

it('keeps the column type for custom casts', () => {
  const Custom = defineModel('cast_types_sqlite', {
    casts: { meta_text: binaryCast(), code_int: encryptedCast('secret'), count_text: { castUsing: () => 'number' as const } },
  })
  type Record = Attributes<typeof Custom>

  expectTypeOf<Record['meta_text']>().toEqualTypeOf<string>()
  expectTypeOf<Record['code_int']>().toEqualTypeOf<number>()
  expectTypeOf<Record['count_text']>().toEqualTypeOf<string>()
})
