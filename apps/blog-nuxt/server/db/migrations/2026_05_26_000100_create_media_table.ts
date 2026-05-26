import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('media', (table) => {
      table.id()
      table.uuid('uuid').unique()
      table.string('model_type')
      table.string('model_id')
      table.string('collection_name').default('default')
      table.string('name')
      table.string('file_name')
      table.string('disk')
      table.string('conversions_disk').nullable()
      table.string('mime_type').nullable()
      table.string('extension').nullable()
      table.bigInteger('size')
      table.string('path')
      table.json('generated_conversions').default({})
      table.integer('order_column').default(1)
      table.timestamps()
      table.index(['model_type', 'model_id'])
      table.index(['model_type', 'model_id', 'collection_name'])
    })
  },
  async down({ schema }) {
    await schema.dropTable('media')
  },
})
