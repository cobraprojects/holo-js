import { defineModel } from '@holo-js/db'
import { tags } from '../db/schema.generated'

export default defineModel(tags, {
  fillable: ['name', 'slug'],
})
