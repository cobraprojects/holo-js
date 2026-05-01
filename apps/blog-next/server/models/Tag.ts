import { defineModel } from '@holo-js/db'

export default defineModel('tags', {
  fillable: ['name', 'slug'],
})
