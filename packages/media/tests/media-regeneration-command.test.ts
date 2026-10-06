import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  column, configureDB, createConnectionManager, createDatabase, createDialect,
  createSchemaService, defineGeneratedTable, defineModel, resetDB,
} from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import * as media from '../src'
import { configureQueueRuntime, resetQueueRuntime } from '@holo-js/queue'
import { configureStorageRuntime, resetStorageRuntime, Storage } from '@holo-js/storage/runtime'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import { regenerateMediaConversions, type MediaRegenerationOptions } from '../../cli/src/media-regeneration'

const Post = defineModel(defineGeneratedTable('posts', { id: column.id() }), { name: 'Post', morphClass: 'post' })
const Product = defineModel(defineGeneratedTable('products', { id: column.id() }), { name: 'Product' })
const models = [Post.definition, Product.definition]
const defaults: MediaRegenerationOptions = { models: [], ids: [], only: [], onlyMissing: false }
let root: string
let manager: ReturnType<typeof createConnectionManager>

function registerConversions(width: number): void {
  for (const model of [Post, Product]) {
    media.defineMediaModel(model, {
      conversions: [media.conversion('thumb').width(width).queued(), media.conversion('card').width(width)],
    })
  }
}

async function addMedia(modelType: string, modelId = '99') {
  const uuid = crypto.randomUUID()
  const path = `${uuid}/original.png`
  const contents = await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } }).png().toBuffer()
  await Storage.disk('originals').put(path, contents)
  return media.Media.create({
    uuid, model_type: modelType, model_id: modelId, collection_name: 'default',
    name: 'image', file_name: 'original.png', disk: 'originals', conversions_disk: 'conversions',
    mime_type: 'image/png', extension: 'png', size: contents.length, path, generated_conversions: {},
  })
}

async function conversionWidth(id: number, name = 'thumb'): Promise<number | undefined> {
  const record = await media.Media.findOrFail(id)
  const variant = record.get('generated_conversions')[name]
  if (!variant) return undefined
  const bytes = await Storage.disk(variant.disk).getBytes(variant.path)
  if (!bytes) return undefined
  return (await sharp(bytes).metadata()).width
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holo-media-regenerate-'))
  const db = createDatabase({ connectionName: 'default', adapter: createSQLiteAdapter({}), dialect: createDialect('sqlite') })
  manager = createConnectionManager({ defaultConnection: 'default', connections: { default: db } })
  configureDB(manager)
  const schema = createSchemaService(db)
  await schema.createTable('media', table => {
    table.id()
    table.uuid('uuid').unique()
    table.string('model_type')
    table.string('model_id')
    table.string('collection_name')
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
  })
  const disks = Object.fromEntries(['originals', 'conversions', 'fallback'].map(name => [name, {
    name, driver: 'local' as const, visibility: 'private' as const, root: join(root, name),
  }]))
  const backends = new Map(Object.entries(disks).map(([name, disk]) => [name, storageRuntimeInternals.createFileStorageBackend(disk.root)]))
  configureStorageRuntime({
    getRuntimeConfig: () => ({ holoStorage: { defaultDisk: 'fallback', diskNames: Object.keys(disks), routePrefix: '/storage', disks } }),
    getStorage: base => {
      const backend = backends.get(base.replace('holo:', ''))
      if (!backend) throw new Error(`Unknown disk: ${base}`)
      return backend
    },
  })
  media.resetMediaRuntime()
  configureQueueRuntime()
  registerConversions(10)
})

afterEach(async () => {
  await resetQueueRuntime()
  resetStorageRuntime()
  media.resetMediaRuntime()
  await manager.disconnectAll()
  resetDB()
  await rm(root, { recursive: true, force: true })
})

describe('media:regenerate', () => {
  it('regenerates all models and preserves original and conversion disks', async () => {
    const post = await addMedia('post')
    const product = await addMedia('Product')
    product.forceFill({ conversions_disk: null })
    await product.save()
    expect(await regenerateMediaConversions({ media, storage: Storage }, models, defaults)).toEqual({ regenerated: 2, skipped: 0 })
    expect(await conversionWidth(post.get('id'))).toBe(10)
    expect(await conversionWidth(product.get('id'), 'card')).toBe(10)
    await product.refresh()
    expect(product.get('generated_conversions').card?.disk).toBe('originals')
    expect((await Storage.disk('fallback').listFiles()).paths).toEqual([])
    expect(await Storage.disk('originals').exists(post.get('path'))).toBe(true)
  })

  it('combines multiple model names, media IDs, and conversion filters', async () => {
    const post = await addMedia('post', '99')
    const product = await addMedia('Product', '99')
    const excluded = await addMedia('post', String(post.get('id')))
    await regenerateMediaConversions({ media, storage: Storage }, models, {
      ...defaults, models: ['Post', 'Product'], ids: [post.get('id'), product.get('id')], only: ['thumb'],
    })
    expect(await conversionWidth(post.get('id'))).toBe(10)
    expect(await conversionWidth(product.get('id'))).toBe(10)
    expect(await conversionWidth(post.get('id'), 'card')).toBeUndefined()
    expect(await conversionWidth(excluded.get('id'))).toBeUndefined()
    expect(await regenerateMediaConversions({ media, storage: Storage }, models, {
      ...defaults, models: ['post'], ids: [product.get('id')],
    })).toEqual({ regenerated: 0, skipped: 0 })
  })

  it('regenerates missing files while preserving existing conversions', async () => {
    const record = await addMedia('post')
    await regenerateMediaConversions({ media, storage: Storage }, models, defaults)
    await record.refresh()
    const card = record.get('generated_conversions').card
    if (!card) throw new Error('Expected card conversion')
    await Storage.disk(card.disk).delete(card.path)
    registerConversions(20)
    expect(await regenerateMediaConversions({ media, storage: Storage }, models, { ...defaults, onlyMissing: true })).toEqual({ regenerated: 1, skipped: 0 })
    expect(await conversionWidth(record.get('id'))).toBe(10)
    expect(await conversionWidth(record.get('id'), 'card')).toBe(20)
    expect(await regenerateMediaConversions({ media, storage: Storage }, models, { ...defaults, onlyMissing: true })).toEqual({ regenerated: 0, skipped: 1 })
  })

  it('reports unknown models, conversions, and missing original files', async () => {
    const record = await addMedia('post')
    await expect(regenerateMediaConversions({ media, storage: Storage }, models, { ...defaults, models: ['Missing'] })).rejects.toThrow('Unknown model')
    await expect(regenerateMediaConversions({ media, storage: Storage }, models, { ...defaults, only: ['missing'] })).rejects.toThrow('Unknown media conversion')
    await Storage.disk('originals').delete(record.get('path'))
    await expect(regenerateMediaConversions({ media, storage: Storage }, models, defaults)).rejects.toThrow('original file is missing')
  })

})
