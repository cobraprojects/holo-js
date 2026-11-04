import { expectTypeOf, it } from 'vitest'
import { column, defineFactory, defineGeneratedTable, defineModel, hasMany, hasOne, type Entity, type InferInsert, type InferSelect, type InferUpdate } from '../src'
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

const flags = defineModel(defineGeneratedTable('computed_flags', { id: column.id(), active: column.boolean(), payload: column.json() }), { timestamps: false })
const untypedCounters = defineModel('computed_untyped_counters', { timestamps: false })

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
    // @ts-expect-error computed columns cannot be updated as json
    await query.updateJson('total', 2)
    // @ts-expect-error computed columns cannot be updated as json
    await query.updateJson('label->first', 'Pen')
    // @ts-expect-error computed columns cannot be upsert update columns
    await query.upsert({ price: 1, quantity: 2, name: 'Pen' }, ['name'], ['total'])
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
    await products.query().upsert({ price: 1, quantity: 2, name: 'Pen' }, ['total'], ['price'])
    await products.where('total', 2).updateJson('note', null)
    expectTypeOf(products.make({ name: 'Pen' }).get('total')).toEqualTypeOf<number | null>()
    expectTypeOf(await shelf.products().create({ price: 1, name: 'Pen' })).toHaveProperty('total').toEqualTypeOf<number | null>()
  }
  expectTypeOf(write).toBeFunction()
})

it('rejects computed columns in factory overrides', () => {
  const productFactory = defineFactory(products, () => ({ price: 1, quantity: 2, name: 'Pen' }))
  const write = async () => {
    await productFactory.create({ note: 'gift' })
    // @ts-expect-error computed columns cannot be factory overrides
    await productFactory.create({ total: 2 })
    // @ts-expect-error computed columns cannot be factory overrides
    await productFactory.make({ label: 'Pen' })
  }
  expectTypeOf(write).toBeFunction()
})

it('limits increment and decrement to writable numeric columns', () => {
  const arithmetic = async () => {
    await products.increment('price')
    await products.where('price', 1).decrement('quantity', 2)
    await products.incrementEach({ price: 1 })
    // @ts-expect-error computed columns cannot be incremented
    await products.increment('total')
    // @ts-expect-error computed columns cannot be decremented
    await products.decrement('total')
    // @ts-expect-error computed columns cannot be incremented
    await products.where('price', 1).increment('total')
    // @ts-expect-error computed columns cannot be decremented
    await products.where('price', 1).decrement('total')
    // @ts-expect-error computed columns cannot be incremented
    await products.incrementEach({ total: 1 })
    // @ts-expect-error computed columns cannot be decremented
    await products.decrementEach({ total: 1 })
    // @ts-expect-error computed columns cannot be incremented
    await products.where('price', 1).incrementEach({ total: 1 })
    // @ts-expect-error computed columns cannot be decremented
    await products.where('price', 1).decrementEach({ total: 1 })
    // @ts-expect-error boolean columns are not numeric
    await flags.increment('active')
    // @ts-expect-error json columns are not numeric
    await flags.increment('payload')
    // @ts-expect-error json columns are not numeric
    await flags.where('id', 1).decrementEach({ payload: 1 })
  }
  expectTypeOf(arithmetic).toBeFunction()
})

it('leaves increment and decrement unrestricted on untyped models', () => {
  const arithmetic = async () => {
    await untypedCounters.increment('visits')
    await untypedCounters.where('id', 1).decrementEach({ stock: 2 })
  }
  expectTypeOf(arithmetic).toBeFunction()
})

it('limits insertUsing destinations to bare writable columns', () => {
  const copy = async () => {
    await products.insertUsing(['price', 'quantity', 'name'], products.select('price', 'quantity', 'name'))
    await products.where('price', 1).insertOrIgnoreUsing(['price', 'quantity', 'name'], products.select('price', 'quantity', 'name'))
    await products.insertUsing(['id', 'price'], products.select('quantity', 'price'))
    await products.query().upsert({ price: 1, quantity: 2, name: 'Pen' }, ['id'], ['id', 'price'])
    // @ts-expect-error computed columns cannot be insertUsing destinations
    await products.insertUsing(['price', 'total'], products.select('price', 'total'))
    // @ts-expect-error computed columns cannot be insertOrIgnoreUsing destinations
    await products.where('price', 1).insertOrIgnoreUsing(['label'], products.select('label'))
    // @ts-expect-error insertUsing destinations take bare column names
    await products.insertUsing(['computed_builder_sqlite.price'], products.select('price'))
    // @ts-expect-error insertOrIgnoreUsing destinations take bare column names
    await products.where('price', 1).insertOrIgnoreUsing(['computed_builder_sqlite.price'], products.select('price'))
  }
  expectTypeOf(copy).toBeFunction()
})

it('limits qualified write targets to the model own table', () => {
  const write = async () => {
    await products.increment('computed_builder_sqlite.price')
    await products.where('price', 1).decrementEach({ 'computed_builder_sqlite.quantity': 1 })
    await products.query().upsert({ price: 1, quantity: 2, name: 'Pen' }, ['name'], ['computed_builder_sqlite.price'])
    await products.where('price', 1).updateJson('computed_builder_sqlite.note', null)
    // @ts-expect-error qualified arithmetic targets must use the model table
    await products.increment('joined.price')
    // @ts-expect-error qualified arithmetic targets must use the model table
    await products.where('price', 1).incrementEach({ 'joined.price': 1 })
    // @ts-expect-error qualified upsert update columns must use the model table
    await products.query().upsert({ price: 1, quantity: 2, name: 'Pen' }, ['name'], ['joined.price'])
    // @ts-expect-error qualified json write targets must use the model table
    await products.where('price', 1).updateJson('joined.note', null)
  }
  expectTypeOf(write).toBeFunction()
})

it('leaves qualified write targets unrestricted on untyped models', () => {
  const write = async () => {
    await untypedCounters.increment('joined.visits')
    await untypedCounters.insertUsing(['joined.visits'], untypedCounters.select('visits'))
  }
  expectTypeOf(write).toBeFunction()
})

it('exposes computed columns as readonly entity attributes', () => {
  const write = (product: Entity<typeof computedBuilderSqlite>) => {
    product.set('price', 2)
    product.price = 3
    expectTypeOf(product.total).toEqualTypeOf<number | null>()
    expectTypeOf(product.get('label')).toEqualTypeOf<string | null>()
    // @ts-expect-error computed columns cannot be set
    product.set('total', 100)
    // @ts-expect-error computed columns are readonly
    product.total = 100
  }
  expectTypeOf(write).toBeFunction()
})

it('leaves Entity.set() unrestricted on untyped models', () => {
  const write = async () => {
    const counter = await untypedCounters.findOrFail(1)
    counter.set('visits', 2)
  }
  expectTypeOf(write).toBeFunction()
})
