import { expectTypeOf, it } from 'vitest'
import { column, defineGeneratedTable, defineModel, hasMany, hasOne, type Entity, type InferInsert, type InferSelect, type InferUpdate } from '../src'
import type { computedBuilderSqlite, computedRawSqlite } from './fixtures/computed-columns/sqlite.generated'
import type { computedBuilderPostgres, computedRawPostgres } from './fixtures/computed-columns/postgres.generated'
import type { computedBuilderMysql, computedRawMysql } from './fixtures/computed-columns/mysql.generated'

type ProductTables = typeof computedBuilderSqlite | typeof computedBuilderPostgres | typeof computedBuilderMysql
type ProductColumn = 'id' | 'price' | 'quantity' | 'name' | 'note'

const products = defineModel('computed_builder_sqlite', { timestamps: false })
const shelves = defineModel(defineGeneratedTable('computed_shelves', { id: column.id() }), {
  timestamps: false,
  relations: {
    products: hasMany(() => products, 'quantity'),
    featured: hasOne(() => products, 'quantity'),
  },
})

it('leaves computed columns out of the insert and update types of every dialect', () => {
  expectTypeOf<keyof InferInsert<typeof computedBuilderSqlite>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedBuilderPostgres>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedBuilderMysql>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferUpdate<ProductTables>>().toEqualTypeOf<ProductColumn>()
  expectTypeOf<keyof InferInsert<typeof computedRawSqlite>>().toEqualTypeOf<'id' | 'width' | 'height'>()
  expectTypeOf<keyof InferInsert<typeof computedRawPostgres>>().toEqualTypeOf<'id' | 'width' | 'height'>()
  expectTypeOf<keyof InferInsert<typeof computedRawMysql>>().toEqualTypeOf<'id' | 'width' | 'height'>()
})

it('types computed columns as nullable exactly when the database made them nullable', () => {
  expectTypeOf<InferSelect<typeof computedBuilderSqlite>['total']>().toEqualTypeOf<number | null>()
  expectTypeOf<InferSelect<typeof computedBuilderMysql>['total']>().toEqualTypeOf<number | null>()
  expectTypeOf<InferSelect<typeof computedBuilderPostgres>['total']>().toEqualTypeOf<number>()
  expectTypeOf<InferSelect<typeof computedRawMysql>['area']>().toEqualTypeOf<number>()
})

it('lets Model.create() omit computed columns', () => {
  expectTypeOf(products.create).toBeCallableWith({ price: 1, quantity: 2, name: 'Pen' })
})

it('rejects computed columns in Entity.fill() and Entity.update()', () => {
  const fill = (product: Entity<typeof computedBuilderSqlite>) => {
    product.fill({ price: 2 })
    // @ts-expect-error computed columns cannot be filled
    product.fill({ total: 1 })
    // @ts-expect-error computed columns cannot be updated
    void product.update({ total: 1 })
  }
  expectTypeOf(fill).toBeFunction()
})

it('rejects computed columns in the values written by static model writes', () => {
  const write = async () => {
    // @ts-expect-error computed columns cannot be created
    await products.create({ price: 1, quantity: 2, name: 'Pen', total: 2 })
    // @ts-expect-error computed columns cannot be created
    await products.createQuietly({ price: 1, quantity: 2, name: 'Pen', total: 2 })
    // @ts-expect-error computed columns cannot be created
    await products.createMany([{ price: 1, quantity: 2, name: 'Pen', total: 2 }])
    // @ts-expect-error computed columns cannot be created
    await products.createManyQuietly([{ price: 1, quantity: 2, name: 'Pen', label: 'Pen' }])
    // @ts-expect-error computed columns cannot be updated
    await products.update(1, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.updateOrCreate({ name: 'Pen' }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.upsert({ name: 'Pen' }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.firstOrCreate({ name: 'Pen' }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.firstOrNew({ name: 'Pen' }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.createOrFirst({ name: 'Pen' }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    products.make({ total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.increment('price', 1, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await products.decrement('price', 1, { label: 'Pen' })
  }
  expectTypeOf(write).toBeFunction()
})

it('rejects computed columns in the values written by model query writes', () => {
  const write = async () => {
    const query = products.where('price', '>', 1)
    // @ts-expect-error computed columns cannot be updated
    await query.update({ total: 2 })
    // @ts-expect-error computed columns cannot be written
    await query.increment('price', 1, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await query.decrement('price', 1, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await query.incrementEach({ price: 1 }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await query.decrementEach({ price: 1 }, { total: 2 })
    // @ts-expect-error computed columns cannot be written
    await query.upsert({ price: 1, quantity: 2, name: 'Pen', total: 2 }, ['name'])
  }
  expectTypeOf(write).toBeFunction()
})

it('rejects computed columns in forceFill()', () => {
  const fill = (product: Entity<typeof computedBuilderSqlite>) => {
    product.forceFill({ price: 2 })
    // @ts-expect-error computed columns cannot be filled
    product.forceFill({ total: 1 })
  }
  expectTypeOf(fill).toBeFunction()
})

it('rejects computed columns in the values written through relations', () => {
  const write = async (shelf: Entity<typeof shelves.definition.table, typeof shelves.definition.relations>) => {
    // @ts-expect-error computed columns cannot be created
    await shelf.products().create({ price: 1, name: 'Pen', total: 2 })
    // @ts-expect-error computed columns cannot be created
    await shelf.products().createMany([{ price: 1, name: 'Pen', total: 2 }])
    // @ts-expect-error computed columns cannot be created
    await shelf.featured().create({ price: 1, name: 'Pen', label: 'Pen' })
  }
  expectTypeOf(write).toBeFunction()
})

it('keeps lookups on computed columns and infers the written entity', () => {
  const write = async (shelf: Entity<typeof shelves.definition.table, typeof shelves.definition.relations>) => {
    expectTypeOf((await products.create({ price: 1, quantity: 2, name: 'Pen' })).get('total')).toEqualTypeOf<number | null>()
    expectTypeOf((await products.firstOrCreate({ total: 2 }, { price: 1, quantity: 2, name: 'Pen' })).get('label')).toEqualTypeOf<string | null>()
    await products.updateOrCreate({ total: 2 }, { note: null })
    await products.upsert({ label: 'Pen' }, { price: 3 })
    await products.firstOrNew({ total: 2 }, { name: 'Pen' })
    await products.createOrFirst({ total: 2 }, { name: 'Pen' })
    await products.increment('price', 1, { note: 'more' })
    await products.where('total', '>', 1).update({ note: null })
    expectTypeOf(products.make({ name: 'Pen' }).get('total')).toEqualTypeOf<number | null>()
    expectTypeOf(await shelf.products().create({ price: 1, name: 'Pen' })).toHaveProperty('total').toEqualTypeOf<number | null>()
  }
  expectTypeOf(write).toBeFunction()
})

