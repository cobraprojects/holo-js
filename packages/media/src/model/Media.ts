import { column, defineGeneratedTable, defineModel, morphTo } from '@holo-js/db'
import type { StoredMediaConversion } from '../registry'

export type GeneratedMediaConversions = Readonly<Record<string, StoredMediaConversion>>

const mediaTable = defineGeneratedTable('media', {
  id: column.id(),
  uuid: column.uuid().unique(),
  model_type: column.string(),
  model_id: column.string(),
  collection_name: column.string().default('default'),
  name: column.string(),
  file_name: column.string(),
  disk: column.string(),
  conversions_disk: column.string().nullable(),
  mime_type: column.string().nullable(),
  extension: column.string().nullable(),
  size: column.bigInteger(),
  path: column.string(),
  generated_conversions: column.json<GeneratedMediaConversions>('generated_conversions').default({}),
  order_column: column.integer().default(1),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
}, {
  indexes: [
    { columns: ['model_type', 'model_id'], unique: false },
    { columns: ['model_type', 'model_id', 'collection_name'], unique: false },
  ],
})

export const Media = defineModel(mediaTable, {
  fillable: [
    'uuid',
    'model_type',
    'model_id',
    'collection_name',
    'name',
    'file_name',
    'disk',
    'conversions_disk',
    'mime_type',
    'extension',
    'size',
    'path',
    'generated_conversions',
    'order_column',
  ],
  casts: {
    generated_conversions: 'json',
  },
  relations: {
    model: morphTo('model'),
  },
})
