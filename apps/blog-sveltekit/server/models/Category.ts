import { defineModel } from '@holo-js/db'

export default defineModel('categories', {
  fillable: ['name', 'slug', 'description'],
})
