import { expectTypeOf, it } from 'vitest'
import { column, defineGeneratedTable, defineModel } from '../src'

const Product = defineModel(defineGeneratedTable('products', { id: column.id(), price: column.integer(), label: column.string() }), { timestamps: false })

it('accepts arithmetic columns qualified with the model table and rejects other tables', () => {
  const adjust = async () => {
    await Product.increment('products.price')
    await Product.decrement('products.price', 2)
    await Product.where('id', 1).incrementEach({ 'products.price': 1 })
    await Product.where('id', 1).decrementEach({ 'products.price': 1 })
    // @ts-expect-error arithmetic columns must belong to the model table
    await Product.increment('orders.price')
    // @ts-expect-error arithmetic columns must belong to the model table
    await Product.where('id', 1).decrement('orders.price')
    // @ts-expect-error arithmetic columns must belong to the model table
    await Product.where('id', 1).incrementEach({ 'orders.price': 1 })
  }
  expectTypeOf(adjust).toBeFunction()
})
