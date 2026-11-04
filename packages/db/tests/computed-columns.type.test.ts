import { expectTypeOf, it } from 'vitest'
import { defineModel, type InferInsert, type InferUpdate } from '../src'
import type { computedBuilderSqlite, computedRawSqlite } from './fixtures/computed-columns/sqlite.generated'
import type { computedBuilderPostgres, computedRawPostgres } from './fixtures/computed-columns/postgres.generated'
import type { computedBuilderMysql, computedRawMysql } from './fixtures/computed-columns/mysql.generated'

type ProductTables = typeof computedBuilderSqlite | typeof computedBuilderPostgres | typeof computedBuilderMysql
type ProductColumn = 'id' | 'price' | 'quantity' | 'name' | 'note'

const products = defineModel('computed_builder_sqlite', { timestamps: false })

it('leaves computed columns out of the insert and update types of every dialect', () => {
  expectTypeOf<keyof InferInsert<typeof computedBuilderSqlite>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedBuilderPostgres>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedBuilderMysql>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferUpdate<ProductTables>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedRawSqlite>>().toEqualTypeOf<'id' | 'width' | 'height'>()
  expectTypeOf<keyof InferInsert<typeof computedRawPostgres>>().toEqualTypeOf<'id' | 'width' | 'height'>()
  expectTypeOf<keyof InferInsert<typeof computedRawMysql>>().toEqualTypeOf<'id' | 'width' | 'height'>()
})

it('lets Model.create() omit computed columns', () => {
  expectTypeOf(products.create).toBeCallableWith({ price: 1, quantity: 2, name: 'Pen' })
})
