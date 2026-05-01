import { defineModel } from '@holo-js/db'
import { categories } from '../db/schema.generated'

export default defineModel(categories, {
  fillable: ['name', 'slug', 'description'],
})
