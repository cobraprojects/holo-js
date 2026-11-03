import { expectTypeOf, it } from 'vitest'
import { defineModel } from '../src'
import type {} from './fixtures/column-defaults/sqlite.generated'
import type {} from './fixtures/column-defaults/postgres.generated'
import type {} from './fixtures/column-defaults/mysql.generated'

type InsertPayload<TModel extends { create(...args: never[]): unknown }> = Parameters<TModel['create']>[0]

const sqliteModel = defineModel('column_defaults_raw_sqlite', { timestamps: false })
const postgresModel = defineModel('column_defaults_raw_postgres', { timestamps: false })
const mysqlModel = defineModel('column_defaults_raw_mysql', { timestamps: false })

it('lets create omit every column the database fills with a literal, now or expression default', () => {
  expectTypeOf<Record<never, never>>().toExtend<InsertPayload<typeof sqliteModel>>()
  expectTypeOf<Record<never, never>>().toExtend<InsertPayload<typeof postgresModel>>()
  expectTypeOf<Record<never, never>>().toExtend<InsertPayload<typeof mysqlModel>>()})
