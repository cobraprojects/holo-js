import { expectTypeOf, it } from 'vitest'
import { column, defineGeneratedTable, defineModel } from '../src'

const Product = defineModel(defineGeneratedTable('products', { id: column.id(), price: column.integer() }), { timestamps: false })

it('accepts aggregate columns of joined tables and rejects tables the query does not join', () => {
  const aggregate = async () => {
    await Product.query().join('orders', 'orders.product_id', '=', 'products.id').sum('orders.amount')
    await Product.query().join('orders as o', 'o.product_id', '=', 'products.id').max('o.amount')
    await Product.query().max('products.price')
    // @ts-expect-error aggregate columns must belong to the model table or a joined table
    await Product.query().sum('orders.amount')
    // @ts-expect-error aggregate columns must belong to the model table or a joined table
    await Product.query().join('orders', 'orders.product_id', '=', 'products.id').avg('refunds.amount')
  }
  expectTypeOf(aggregate).toBeFunction()
})
