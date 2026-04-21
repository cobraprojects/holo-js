import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Storage } from '@holo-js/storage/runtime'
import {
  column,
  createConnectionManager,
  createDatabase,
  createDialect,
  DB,
  defineGeneratedTable,
  createSchemaService,
  createSQLiteAdapter,
  defineModel,
  configureDB,
  resetDB,
} from '@holo-js/db'
import {
  configureQueueRuntime,
  listRegisteredQueueJobs,
  resetQueueRegistry,
  resetQueueRuntime,
  runQueueWorker,
  type QueueAsyncDriver,
  type QueueDriverDispatchResult,
  type QueueDriverFactory,
  type QueueJobEnvelope,
  type QueueJsonValue,
  type QueueReserveInput,
  type QueueReservedJob,
} from '@holo-js/queue'
import { createQueueDbRuntimeOptions } from '../../queue-db/src'
import {
  Media,
  collection,
  conversion,
  createDefaultMediaConversionExecutor,
  dispatchQueuedMediaConversions,
  defineMediaModel,
  ensureMediaQueueJobRegistered,
  getMediaConversionExecutor,
  getMediaDefinition,
  getMediaDefinitionForMorphClass,
  getMediaPathGenerator,
  MEDIA_GENERATE_CONVERSIONS_JOB,
  MediaItem,
  normalizeCollectionDefinitions,
  normalizeMediaDefinition,
  resetMediaPathGenerator,
  resetMediaRuntime,
  requireMediaDefinition,
  requireMediaDefinitionForMorphClass,
  registerMediaDefinition,
  resolveMediaDefinition,
  resolveMediaCollection,
  resolveMediaConversion,
  runMediaGenerateConversionsJob,
  setMediaConversionExecutor,
  setMediaPathGenerator,
} from '../src'

const sharedRedisConfig = {
  default: 'default',
  connections: {
    default: {
      name: 'default',
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      username: undefined,
      db: 0,
    },
  },
} as const

type RuntimeMediaEntity = {
  getMedia(collectionName?: string): Promise<unknown[]>
  getMediaUrls(collectionName?: string, conversionName?: string): Promise<string[]>
  getMediaPaths(collectionName?: string, conversionName?: string): Promise<string[]>
  getFirstMedia(collectionName?: string): Promise<unknown>
  getFirstMediaUrl(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstMediaPath(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstTemporaryUrl(collectionName?: string, conversionName?: string): Promise<string | null>
  hasMedia(collectionName?: string): Promise<boolean>
  clearMediaCollection(collectionName?: string): Promise<void>
  regenerateMedia(collectionName?: string, conversions?: string | readonly string[]): Promise<void>
  addMedia(source: Buffer): { toMediaCollection(collectionName?: string): Promise<unknown> }
  addMediaFromUrl(url: string): { toMediaCollection(collectionName?: string): Promise<unknown> }
}

const postsTable = defineGeneratedTable('posts', {
  id: column.id(),
  title: column.string(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
})

const storageState = vi.hoisted(() => {
  const disks = new Map<string, Map<string, Uint8Array>>()
  const deleteFailures = new Set<string>()
  let defaultDiskName = 'public'

  const normalizePath = (value: string) => value.trim().replace(/^\/+/, '').replace(/\/+/g, '/')

  const toBytes = async (value: string | Uint8Array | ArrayBuffer | Buffer | Blob): Promise<Uint8Array> => {
    if (typeof value === 'string') {
      return new TextEncoder().encode(value)
    }

    if (value instanceof Uint8Array) {
      return value
    }

    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value)
    }

    if (Buffer.isBuffer(value)) {
      return value
    }

    return new Uint8Array(await value.arrayBuffer())
  }

  const getDiskStore = (name: string) => {
    const existing = disks.get(name)
    if (existing) {
      return existing
    }

    const created = new Map<string, Uint8Array>()
    disks.set(name, created)
    return created
  }

  return {
    disks,
    deleteFailures,
    normalizePath,
    toBytes,
    getDiskStore,
    failDelete(diskName: string, path: string) {
      deleteFailures.add(`${diskName}:${normalizePath(path)}`)
    },
    shouldFailDelete(diskName: string, path: string) {
      return deleteFailures.has(`${diskName}:${normalizePath(path)}`)
    },
    getDefaultDisk() {
      return defaultDiskName
    },
    setDefaultDisk(diskName: string) {
      defaultDiskName = diskName
    },
    reset() {
      disks.clear()
      deleteFailures.clear()
      defaultDiskName = 'public'
    },
  }
})

vi.mock('@holo-js/storage/runtime', () => {
  const createDisk = (diskName = storageState.getDefaultDisk()) => ({
    name: diskName,
    driver: diskName === 's3' ? 's3' : diskName === 'public' ? 'public' : 'local',
    visibility: diskName === 'local' || diskName === 'broken' ? 'private' : 'public',
    async put(path: string, contents: string | Uint8Array | ArrayBuffer | Buffer | Blob) {
      storageState.getDiskStore(diskName).set(
        storageState.normalizePath(path),
        await storageState.toBytes(contents),
      )
      return true
    },
    async putJson(path: string, value: unknown) {
      storageState.getDiskStore(diskName).set(
        storageState.normalizePath(path),
        new TextEncoder().encode(JSON.stringify(value)),
      )
      return true
    },
    async get(path: string) {
      const value = storageState.getDiskStore(diskName).get(storageState.normalizePath(path))
      return value ? new TextDecoder().decode(value) : null
    },
    async getBytes(path: string) {
      return storageState.getDiskStore(diskName).get(storageState.normalizePath(path)) ?? null
    },
    async json<T>(path: string) {
      const value = storageState.getDiskStore(diskName).get(storageState.normalizePath(path))
      return value ? JSON.parse(new TextDecoder().decode(value)) as T : null
    },
    async exists(path: string) {
      return storageState.getDiskStore(diskName).has(storageState.normalizePath(path))
    },
    async missing(path: string) {
      return !storageState.getDiskStore(diskName).has(storageState.normalizePath(path))
    },
    async delete(path: string | string[]) {
      const targets = Array.isArray(path) ? path : [path]
      for (const target of targets) {
        if (storageState.shouldFailDelete(diskName, target)) {
          throw new Error(`delete failed for ${diskName}:${storageState.normalizePath(target)}`)
        }

        storageState.getDiskStore(diskName).delete(storageState.normalizePath(target))
      }
      return true
    },
    async copy(from: string, to: string) {
      const value = storageState.getDiskStore(diskName).get(storageState.normalizePath(from))
      if (!value) {
        return false
      }

      storageState.getDiskStore(diskName).set(storageState.normalizePath(to), value)
      return true
    },
    async move(from: string, to: string) {
      const copied = await createDisk(diskName).copy(from, to)
      if (copied) {
        await createDisk(diskName).delete(from)
      }

      return copied
    },
    async files(directory = '') {
      const normalized = storageState.normalizePath(directory)
      return [...storageState.getDiskStore(diskName).keys()].filter((key) => {
        return normalized ? key.startsWith(`${normalized}/`) : true
      })
    },
    path(path: string) {
      if (diskName === 'broken') {
        throw new Error('broken disk path')
      }

      return `/virtual/${diskName}/${storageState.normalizePath(path)}`
    },
    url(path: string) {
      if (diskName === 'local' || diskName === 'broken') {
        throw new Error('local disks are private')
      }

      return `https://cdn.test/${diskName}/${storageState.normalizePath(path)}`
    },
    temporaryUrl(path: string, _options?: { expiresAt?: Date | number | string, expiresIn?: number }) {
      if (diskName === 'broken') {
        throw new Error('broken disk temporary url')
      }

      return `https://signed.test/${diskName}/${storageState.normalizePath(path)}`
    },
  })

  const Storage = {
    disk(diskName?: string) {
      return createDisk(diskName)
    },
    put(path: string, contents: string | Uint8Array | ArrayBuffer | Buffer | Blob) {
      return createDisk().put(path, contents)
    },
    putJson(path: string, value: unknown) {
      return createDisk().putJson(path, value)
    },
    get(path: string) {
      return createDisk().get(path)
    },
    getBytes(path: string) {
      return createDisk().getBytes(path)
    },
    json<T>(path: string) {
      return createDisk().json<T>(path)
    },
    exists(path: string) {
      return createDisk().exists(path)
    },
    missing(path: string) {
      return createDisk().missing(path)
    },
    delete(path: string | string[]) {
      return createDisk().delete(path)
    },
    copy(from: string, to: string) {
      return createDisk().copy(from, to)
    },
    move(from: string, to: string) {
      return createDisk().move(from, to)
    },
    files(directory?: string) {
      return createDisk().files(directory)
    },
    path(path: string) {
      return createDisk().path(path)
    },
    url(path: string) {
      return createDisk().url(path)
    },
    temporaryUrl(path: string, options?: { expiresAt?: Date | number | string, expiresIn?: number }) {
      return createDisk().temporaryUrl(path, options)
    },
  }

  return {
    Storage,
    useStorage(diskName?: string) {
      return createDisk(diskName)
    },
  }
})

function createAsyncQueueHarness() {
  const queued: QueueJobEnvelope[] = []
  const reserved = new Map<string, QueueReservedJob>()

  const driver: QueueAsyncDriver = {
    name: 'redis',
    driver: 'redis',
    mode: 'async',
    async dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
      job: QueueJobEnvelope<TPayload>,
    ): Promise<QueueDriverDispatchResult<TResult>> {
      queued.push(job)
      return {
        jobId: job.id,
        synchronous: false,
      } as QueueDriverDispatchResult<TResult>
    },
    async reserve<TPayload extends QueueJsonValue = QueueJsonValue>(
      input: QueueReserveInput,
    ): Promise<QueueReservedJob<TPayload> | null> {
      const index = queued.findIndex((job) => {
        if (!input.queueNames.includes(job.queue)) {
          return false
        }

        return typeof job.availableAt !== 'number' || job.availableAt <= Date.now()
      })

      if (index < 0) {
        return null
      }

      const [envelope] = queued.splice(index, 1)
      const job = Object.freeze({
        reservationId: `reservation-${envelope!.id}`,
        envelope: envelope! as QueueJobEnvelope<TPayload>,
        reservedAt: Date.now(),
      })
      reserved.set(job.reservationId, job)
      return job as QueueReservedJob<TPayload>
    },
    async acknowledge(job) {
      reserved.delete(job.reservationId)
    },
    async release(job, options = {}) {
      reserved.delete(job.reservationId)
      queued.push(Object.freeze({
        ...job.envelope,
        attempts: job.envelope.attempts + 1,
        ...(typeof options.delaySeconds === 'number'
          ? { availableAt: Date.now() + (options.delaySeconds * 1000) }
          : {}),
      }))
    },
    async delete(job) {
      reserved.delete(job.reservationId)
    },
    async clear(input = {}) {
      const before = queued.length
      const queueNames = input.queueNames
      if (!queueNames || queueNames.length === 0) {
        queued.length = 0
        return before
      }

      for (let index = queued.length - 1; index >= 0; index -= 1) {
        if (queueNames.includes(queued[index]!.queue)) {
          queued.splice(index, 1)
        }
      }

      return before - queued.length
    },
    async close() {},
  }

  const factory: QueueDriverFactory = {
    driver: 'redis',
    create() {
      return driver
    },
  }

  return {
    queued,
    reserved,
    driver,
    factory,
  }
}

async function bootDatabase(): Promise<void> {
  const db = createDatabase({
    connectionName: 'default',
    adapter: createSQLiteAdapter({}),
    dialect: createDialect('sqlite'),
  })

  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: {
      default: db,
    },
  }))

  const schema = createSchemaService(db)
  await schema.createTable('posts', (table) => {
    table.id()
    table.string('title')
    table.timestamps()
  })

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
}

async function createQueueTables(): Promise<void> {
  const schema = createSchemaService(DB.connection())
  await schema.createTable('jobs', (table) => {
    table.string('id').primaryKey()
    table.string('job')
    table.string('connection')
    table.string('queue')
    table.text('payload')
    table.integer('attempts').default(0)
    table.integer('max_attempts').default(1)
    table.bigInteger('available_at')
    table.bigInteger('reserved_at').nullable()
    table.string('reservation_id').nullable()
    table.bigInteger('created_at')
  })
}

async function createTempMediaFile(
  fileName: string,
  contents: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'holo-media-'))
  const path = join(directory, fileName)
  await writeFile(path, contents)
  return path
}

async function createImageBuffer(
  format: 'jpeg' | 'png' = 'jpeg',
): Promise<Buffer> {
  const base = sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: { r: 220, g: 40, b: 90 },
    },
  })

  return format === 'png'
    ? base.png().toBuffer()
    : base.jpeg().toBuffer()
}

describe('@holo-js/media', () => {
  beforeEach(async () => {
    resetDB()
    resetQueueRegistry()
    await resetQueueRuntime()
    resetMediaRuntime()
    storageState.reset()
    await bootDatabase()
    configureQueueRuntime()
  })

  it('normalizes media definitions and validates collection references', () => {
    const definition = normalizeMediaDefinition({
      collections: [
        collection('images').acceptsExtensions(['.JPG']).acceptsMimeTypes([' Image/JPEG ']),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').quality(200).format('webp'),
      ],
    })

    expect(definition.collectionsByName.images!.acceptedExtensions).toEqual(['jpg'])
    expect(definition.collectionsByName.images!.acceptedMimeTypes).toEqual(['image/jpeg'])
    expect(definition.conversionsByName.thumb!.quality).toBe(100)

    expect(() => normalizeMediaDefinition({
      collections: [collection('images'), collection('images')],
    })).toThrow('Duplicate media collection')

    expect(() => normalizeMediaDefinition({
      collections: [collection('images')],
      conversions: [conversion('thumb').performOnCollections('missing')],
    })).toThrow('unknown collection "missing"')

    expect(() => normalizeMediaDefinition({
      conversions: [conversion('thumb'), conversion('thumb')],
    })).toThrow('Duplicate media conversion')
  })

  it('covers collection and conversion builder branches', () => {
    const docs = collection('docs')
      .disk(' public ')
      .conversionsDisk(' s3 ')
      .singleFile()
      .onlyKeepLatest(0)
      .acceptsMimeTypes([' Text/Plain ', ''])
      .acceptsExtensions([' .TXT ', ''])
      .maxSize(0)

    expect(docs.definition).toMatchObject({
      diskName: 'public',
      conversionsDiskName: 's3',
      singleFile: true,
      onlyKeepLatest: 1,
      acceptedMimeTypes: ['text/plain'],
      acceptedExtensions: ['txt'],
      maxFileSize: 1,
    })
    expect(normalizeCollectionDefinitions([docs.definition])[0]).toMatchObject({
      disk: 'public',
      conversionsDisk: 's3',
      maxSize: 1,
    })
    expect(normalizeCollectionDefinitions([
      collection('empty').disk(' ').conversionsDisk(' ').definition,
    ])[0]).toMatchObject({
      disk: undefined,
      conversionsDisk: undefined,
    })

    const thumb = conversion('thumb')
      .performOnCollections('images', '' as never)
      .width(0)
      .height(0)
      .fit('cover')
      .format('jpg')
      .quality(0)
      .queued()
      .nonQueued()

    expect(thumb.definition).toMatchObject({
      collections: ['images'],
      width: 1,
      height: 1,
      fit: 'cover',
      format: 'jpg',
      quality: 1,
      queued: false,
    })

    const resolved = resolveMediaDefinition(({ collection: buildCollection }) => ({
      collections: [buildCollection('factory')],
    }))
    expect(resolved.collections?.[0]?.name).toBe('factory')
  })

  it('resolves registry fallbacks and path generator overrides', async () => {
    const PlainPost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const post = await PlainPost.create({ title: 'Plain' })

    expect(getMediaDefinition(PlainPost)).toBeUndefined()
    expect(() => requireMediaDefinition(PlainPost)).toThrow('is not configured for media')
    expect(() => requireMediaDefinitionForMorphClass('missing-model')).toThrow('is not configured for media')
    expect(resolveMediaCollection(PlainPost).name).toBe('default')
    expect(resolveMediaCollection(post as never, 'avatars').name).toBe('avatars')
    expect(resolveMediaConversion(PlainPost, 'thumb')).toBeUndefined()

    const manualDefinition = normalizeMediaDefinition({
      collections: [collection('manual')],
    })
    registerMediaDefinition({ definition: { name: 'ManualOnly' } } as never, manualDefinition)
    expect(getMediaDefinitionForMorphClass('ManualOnly')).toBe(manualDefinition)
    expect(requireMediaDefinitionForMorphClass('ManualOnly')).toBe(manualDefinition)

    const generatedDefault = getMediaPathGenerator().conversionPath({
      uuid: 'abc/123',
      fileName: 'hero',
      collection: resolveMediaCollection(PlainPost),
      conversion: conversion('thumb').format('jpg').definition,
    })
    expect(generatedDefault).toBe('media/abc-123/conversions/thumb.jpg')
    expect(getMediaPathGenerator().conversionPath({
      uuid: 'abc/123',
      fileName: '',
      collection: resolveMediaCollection(PlainPost),
      conversion: conversion('raw').definition,
    })).toBe('media/abc-123/conversions/raw.bin')

    setMediaPathGenerator({
      originalPath() {
        return 'custom/original'
      },
      conversionPath() {
        return 'custom/conversion'
      },
    })

    expect(getMediaPathGenerator().originalPath({
      uuid: 'x',
      fileName: 'y',
      collection: resolveMediaCollection(PlainPost),
    })).toBe('custom/original')

    resetMediaPathGenerator()

    expect(getMediaPathGenerator().originalPath({
      uuid: 'x',
      fileName: 'y',
      collection: resolveMediaCollection(PlainPost),
    })).toBe('media/x/original/y')
  })

  it('returns empty media helpers on models without media configuration', async () => {
    const PlainPost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const post = await PlainPost.create({ title: 'Plain' })
    const runtimePost = post as unknown as RuntimeMediaEntity

    expect(await runtimePost.getMedia()).toEqual([])
    expect(await runtimePost.getMediaUrls()).toEqual([])
    expect(await runtimePost.getMediaPaths()).toEqual([])
    expect(await runtimePost.getFirstMedia()).toBeNull()
    expect(await runtimePost.getFirstMediaUrl()).toBeNull()
    expect(await runtimePost.getFirstMediaPath()).toBeNull()
    expect(await runtimePost.getFirstTemporaryUrl()).toBeNull()
    expect(await runtimePost.hasMedia()).toBe(false)
    await expect(runtimePost.clearMediaCollection()).resolves.toBeUndefined()
    await expect(runtimePost.regenerateMedia()).resolves.toBeUndefined()
    await expect(runtimePost.addMedia(Buffer.from('x')).toMediaCollection()).rejects.toThrow('is not configured for media')
    await expect(runtimePost.addMediaFromUrl('https://example.test/image.jpg').toMediaCollection()).rejects.toThrow('is not configured for media')
  })

  it('keeps the undeclared default collection multi-file', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {})
    const post = await Post.create({ title: 'Default Collection' })

    expect(resolveMediaCollection(Post as never).singleFile).toBe(false)

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.txt',
    }).toMediaCollection()

    await post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.txt',
    }).toMediaCollection()

    const items = await post.getMedia()

    expect(items).toHaveLength(2)
    expect(items.map(item => item.fileName)).toEqual(['first.txt', 'second.txt'])
  })

  it('prefers the public disk for implicit attachments when the storage default is private', async () => {
    storageState.setDefaultDisk('local')

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('misc'),
      ],
    })

    const post = await Post.create({ title: 'Implicit Public Disk' })
    const media = await post
      .addMedia(Buffer.from('original'))
      .usingFileName('photo.jpg')
      .toMediaCollection('misc')

    expect(media.record.disk).toBe('public')
    expect(media.getUrl()).toBeTruthy()
    expect(storageState.getDiskStore('public').has(media.record.path)).toBe(true)
    expect(storageState.getDiskStore('local').size).toBe(0)
  })

  it('rejects invalid sources and handles ownerless entities', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['png'])
          .acceptsMimeTypes(['image/png'])
          .maxSize(2),
      ],
    })

    const draft = Post.make({ title: 'Draft' })
    expect(await draft.getFirstMedia('images')).toBeNull()
    expect(await draft.hasMedia('images')).toBe(false)
    await expect(draft.addMedia(Buffer.from('xx')).toMediaCollection('images')).rejects.toThrow('before it has a persisted primary key')

    const post = await Post.create({ title: 'Live' })
    await expect(post.addMedia({
      contents: Buffer.from('toolarge'),
      fileName: 'hero.png',
      mimeType: 'image/png',
    }).toMediaCollection('images')).rejects.toThrow('exceeds the max size')

    await expect(post.addMedia({
      contents: Buffer.from('ok'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')).rejects.toThrow('accepted MIME type')

    await expect(post.addMedia({
      contents: Buffer.from('ok'),
      fileName: 'hero.jpg',
      mimeType: 'image/png',
    }).toMediaCollection('images')).rejects.toThrow('accepted extension')
  })

  it('accepts MIME types case-insensitively during validation', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['png'])
          .acceptsMimeTypes([' Image/PNG ']),
      ],
    })

    const post = await Post.create({ title: 'Case Insensitive' })

    await expect(post.addMedia({
      contents: Buffer.from('ok'),
      fileName: 'hero.png',
      mimeType: 'IMAGE/PNG',
    }).toMediaCollection('images')).resolves.toBeInstanceOf(MediaItem)
  })

  it('supports different source inputs and adder overrides', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('uploads')
          .disk('public')
          .acceptsExtensions(['txt', 'png'])
          .acceptsMimeTypes(['text/plain', 'image/png']),
      ],
    })

    const post = await Post.create({ title: 'Variants' })
    const path = await createTempMediaFile('notes.txt', 'notes')

    try {
      const fromStringPath = await post
        .addMedia(path)
        .usingName('Custom Name')
        .usingFileName('renamed.txt')
        .onDisk('local')
        .toMediaCollection('uploads')

      const fromPathObject = await post
        .addMedia({ path })
        .toMediaCollection('uploads')

      const fromArrayBuffer = await post
        .addMedia(new TextEncoder().encode('plain').buffer)
        .usingFileName('array.txt')
        .toMediaCollection('uploads')

      const fromBlob = await post
        .addMedia({
          contents: {
            size: 3,
            async arrayBuffer() {
              return Buffer.from('png').buffer.slice(0)
            },
          } as unknown as Blob,
          mimeType: 'image/png',
        })
        .usingFileName('blob.png')
        .toMediaCollection('uploads')

      expect(fromStringPath.record.name).toBe('Custom Name')
      expect(fromStringPath.fileName).toBe('renamed.txt')
      expect(fromStringPath.getUrl()).toBeNull()
      expect(fromStringPath.getPath()).toContain('/virtual/local/')
      expect(fromPathObject.fileName).toBe('notes.txt')
      expect(fromArrayBuffer.fileName).toBe('array.txt')
      expect(fromBlob.mimeType).toBe('image/png')
      expect(fromBlob.size).toBe(3)
      expect(await post.getMedia('uploads')).toHaveLength(4)
    } finally {
      await rm(path.slice(0, path.lastIndexOf('/')), { recursive: true, force: true })
    }
  })

  it('attaches media, generates conversions, and exposes direct model helpers', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`converted:${conversion.name}`),
          fileName: `${conversion.name}.${conversion.format ?? 'bin'}`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['jpg'])
          .onlyKeepLatest(2),
      ],
      conversions: [
        conversion('thumb')
          .performOnCollections('images')
          .format('webp')
          .width(320)
          .height(240),
      ],
    })

    const post = await Post.create({ title: 'Hero' })
    expectTypeOf(post.getFirstMediaUrl('images', 'thumb')).toEqualTypeOf<Promise<string | null>>()
    expect(Post.getRepository().getRelationDefinition('media').kind).toBe('morphMany')

    const media = await post
      .addMedia({
        contents: Buffer.from('original-image'),
        fileName: 'hero.jpg',
      })
      .toMediaCollection('images')

    expect(media.collectionName).toBe('images')
    expect(media.getUrl()).toContain('https://cdn.test/public/media/')
    expect(media.getUrl('thumb')).toContain('/thumb.webp')
    expect(media.getPath()).toContain('/virtual/public/media/')
    expect(media.getTemporaryUrl('thumb')).toContain('https://signed.test/public/')

    expect(await post.hasMedia('images')).toBe(true)
    expect(await post.getMediaUrls('images', 'thumb')).toEqual([media.getUrl('thumb')!])
    expect(await post.getMediaPaths('images', 'thumb')).toEqual([media.getPath('thumb')!])
    expect(await post.getFirstMediaUrl('images')).toBe(media.getUrl())
    expect(await post.getFirstMediaUrl('images', 'thumb')).toBe(media.getUrl('thumb'))
    expect(await post.getFirstMediaPath('images', 'thumb')).toBe(media.getPath('thumb'))
    expect(await post.getFirstTemporaryUrl('images', 'thumb', { expiresIn: 60 })).toBe(media.getTemporaryUrl('thumb', { expiresIn: 60 }))
    expect(media.getEntity().get('collection_name')).toBe('images')
    expect(media.getAvailableConversions()).toEqual(['thumb'])

    const items = await post.getMedia('images')
    expect(items).toHaveLength(1)
    expect(resolveMediaCollection(Post, 'missing').name).toBe('missing')
    expect(resolveMediaConversion(Post, 'thumb')?.name).toBe('thumb')
    expect(items[0]?.toJSON().generated_conversions).toMatchObject({
      thumb: {
        disk: 'public',
      },
    })

    const storedPaths = [...storageState.getDiskStore('public').keys()].sort()
    expect(storedPaths).toHaveLength(2)
    expect(storedPaths[0]).toContain('conversions/thumb.webp')
    expect(storedPaths[1]).toContain('original/hero.jpg')

    expect(await Media.query().count()).toBe(1)

    await post.clearMediaCollection('images')
    expect(await post.hasMedia('images')).toBe(false)
    expect(await Media.query().count()).toBe(0)
    expect(storageState.getDiskStore('public').size).toBe(0)
  })

  it('runs built-in sharp conversions by default', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public').acceptsMimeTypes(['image/png']),
      ],
      conversions: [
        conversion('thumb')
          .performOnCollections('images')
          .format('webp')
          .width(2)
          .height(2)
          .fit('cover'),
      ],
    })

    const post = await Post.create({ title: 'Built-in' })
    const media = await post.addMedia({
      contents: await createImageBuffer('png'),
      fileName: 'hero.png',
      mimeType: 'image/png',
    }).toMediaCollection('images')

    expect(getMediaConversionExecutor()).toBeDefined()

    const conversions = media.record.generated_conversions
    const thumbPath = conversions.thumb?.path
    expect(thumbPath).toBeTruthy()

    const thumbBytes = thumbPath
      ? storageState.getDiskStore('public').get(thumbPath)
      : null
    expect(thumbBytes).toBeInstanceOf(Uint8Array)

    const metadata = await sharp(Buffer.from(thumbBytes!)).metadata()
    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBe(2)
    expect(metadata.height).toBe(2)
  })

  it('covers the default sharp executor output branches', async () => {
    const executor = createDefaultMediaConversionExecutor()
    const image = await createImageBuffer()

    expect(await executor.generate({
      source: {
        uuid: 'plain-text',
        fileName: 'notes',
        extension: undefined,
        mimeType: undefined,
        size: 4,
        contents: Buffer.from('note'),
      },
      collection: collection('docs').definition,
      conversion: conversion('skip').definition,
    })).toBeNull()

    const formats = [
      ['jpg', 'jpg'],
      ['png', 'png'],
      ['avif', 'avif'],
      ['webp', 'webp'],
    ] as const

    for (const [format, extension] of formats) {
      const result = await executor.generate({
        source: {
          uuid: `source-${format}`,
          fileName: 'hero.jpg',
          extension: 'jpg',
          mimeType: format === 'jpg' ? undefined : 'image/jpeg',
          size: image.byteLength,
          contents: format === 'jpg' ? new Uint8Array(image) : image,
        },
        collection: collection('images').definition,
        conversion: conversion(format)
          .format(format)
          .width(2)
          .quality(70)
          .fit(format === 'jpg' ? undefined as never : 'inside')
          .definition,
      })

      expect(result?.fileName).toBe(`hero.${extension}`)
      expect(result?.mimeType).toBeTruthy()
    }

    const containResult = await executor.generate({
      source: {
        uuid: 'contain-source',
        fileName: 'hero.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        size: image.byteLength,
        contents: image,
      },
      collection: collection('images').definition,
      conversion: conversion('contain').format('jpeg').width(2).fit('contain').definition,
    })

    expect(containResult?.fileName).toBe('hero.jpeg')

    const avifDefaultQuality = await executor.generate({
      source: {
        uuid: 'avif-default',
        fileName: 'hero.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        size: image.byteLength,
        contents: image,
      },
      collection: collection('images').definition,
      conversion: conversion('avif-default').format('avif').width(2).definition,
    })

    expect(avifDefaultQuality?.fileName).toBe('hero.avif')

    const svgResult = await executor.generate({
      source: {
        uuid: 'svg-source',
        fileName: '',
        extension: 'svg',
        mimeType: 'image/svg+xml',
        size: 64,
        contents: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>'),
      },
      collection: collection('images').definition,
      conversion: conversion('fallback').definition,
    })

    expect(svgResult?.fileName).toBe('media.png')

    await expect(executor.generate({
      source: {
        uuid: 'broken-image',
        fileName: 'broken.png',
        extension: 'png',
        mimeType: 'image/png',
        size: 7,
        contents: Buffer.from('broken!'),
      },
      collection: collection('images').definition,
      conversion: conversion('broken').definition,
    })).rejects.toThrow('Failed to generate conversion')
  })

  it('resets the lazy sharp loader after import failures so later attempts can retry', async () => {
    vi.resetModules()
    vi.doMock('sharp', () => {
      throw new Error('sharp unavailable')
    })

    try {
      const { createDefaultMediaConversionExecutor: createExecutor } = await import('../src/runtime/image')
      const executor = createExecutor()
      const image = await createImageBuffer()
      const input = {
        source: {
          uuid: 'missing-sharp',
          fileName: 'hero.png',
          extension: 'png',
          mimeType: 'image/png',
          size: image.byteLength,
          contents: image,
        },
        collection: collection('images').definition,
        conversion: conversion('thumb').format('webp').width(2).definition,
      }

      await expect(executor.generate(input)).rejects.toThrow('[Holo Media] Failed to generate conversion "thumb" for "hero.png":')
      await expect(executor.generate(input)).rejects.toThrow('[Holo Media] Failed to generate conversion "thumb" for "hero.png":')
    } finally {
      vi.doUnmock('sharp')
      vi.resetModules()
    }
  })

  it('supports single-file collections and replaces the previous file', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = [...storageState.getDiskStore('public').keys()][0]
    expect(firstPath).toContain('first.jpg')

    await post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')

    const storedPaths = [...storageState.getDiskStore('public').keys()]
    expect(storedPaths).toHaveLength(1)
    expect(storedPaths[0]).toContain('second.jpg')
    expect(await post.getMedia('avatars')).toHaveLength(1)
  })

  it('preserves the existing single-file media when replacement conversion fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
      conversions: [
        conversion('thumb').performOnCollections('avatars').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = [...storageState.getDiskStore('public').keys()][0]
    setMediaConversionExecutor({
      async generate() {
        throw new Error('conversion failed')
      },
    })

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('conversion failed')

    expect(await post.getMedia('avatars')).toHaveLength(1)
    expect(storageState.getDiskStore('public').has(firstPath!)).toBe(true)
  })

  it('rolls back the new single-file media when deleting the previous file fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const existing = await post.getFirstMedia('avatars')
    expect(existing).not.toBeNull()
    storageState.failDelete('public', existing!.record.path)

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('delete failed for public:')

    const items = await post.getMedia('avatars')
    expect(items).toHaveLength(1)
    expect(items[0]?.fileName).toBe('first.jpg')

    const storedPaths = [...storageState.getDiskStore('public').keys()]
    expect(storedPaths).toHaveLength(1)
    expect(storedPaths[0]).toContain('first.jpg')
  })

  it('restores earlier legacy single-file rows when a later cleanup delete fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })
    const modelType = post.getRepository().definition.morphClass
    const modelId = String(post.get('id'))
    const legacyRows = [
      { uuid: 'avatar-1', fileName: 'first.txt', order: 1 },
      { uuid: 'avatar-2', fileName: 'second.txt', order: 2 },
    ]

    for (const row of legacyRows) {
      const path = `media/${row.uuid}/original/${row.fileName}`
      storageState.getDiskStore('public').set(path, Buffer.from(row.fileName))
      await Media.create({
        uuid: row.uuid,
        model_type: modelType,
        model_id: modelId,
        collection_name: 'avatars',
        name: row.fileName,
        file_name: row.fileName,
        disk: 'public',
        conversions_disk: 'public',
        mime_type: 'text/plain',
        extension: 'txt',
        size: row.fileName.length,
        path,
        generated_conversions: {} as never,
        order_column: row.order,
      })
    }

    storageState.failDelete('public', 'media/avatar-2/original/second.txt')

    await expect(post.addMedia({
      contents: Buffer.from('replacement'),
      fileName: 'replacement.txt',
    }).toMediaCollection('avatars')).rejects.toThrow('delete failed for public:')

    const items = await post.getMedia('avatars')
    expect(items.map(item => item.fileName)).toEqual(['first.txt', 'second.txt'])
    expect(storageState.getDiskStore('public').has('media/avatar-1/original/first.txt')).toBe(true)
    expect(storageState.getDiskStore('public').has('media/avatar-2/original/second.txt')).toBe(true)
    expect([...storageState.getDiskStore('public').keys()].some(path => path.includes('replacement.txt'))).toBe(false)
  })

  it('cleans up new conversions when single-file replacement cleanup fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
      conversions: [
        conversion('thumb').performOnCollections('avatars').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const beforeFailure = [...storageState.getDiskStore('public').keys()]
    const existing = await post.getFirstMedia('avatars')
    expect(existing).not.toBeNull()
    storageState.failDelete('public', existing!.record.path)

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('delete failed for public:')

    const storedPaths = [...storageState.getDiskStore('public').keys()]
    expect(storedPaths).toEqual(beforeFailure)
    expect(storedPaths.some(path => path.includes('second.jpg'))).toBe(false)
  })

  it('preserves the original media row when a conversion delete fails during item deletion', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').format('webp'),
      ],
    })

    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('thumb'),
          fileName: 'thumb.webp',
          mimeType: 'image/webp',
        }
      },
    })

    const post = await Post.create({ title: 'Avatar' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'first.jpg',
    }).toMediaCollection('images')

    const thumbPath = media.record.generated_conversions.thumb?.path
    expect(thumbPath).toBeTruthy()
    storageState.failDelete('public', thumbPath!)

    await expect(media.delete()).rejects.toThrow('delete failed for public:')

    expect(storageState.getDiskStore('public').has(media.record.path)).toBe(true)
    expect(storageState.getDiskStore('public').has(thumbPath!)).toBe(true)
    expect(await Media.query().count()).toBe(1)
  })

  it('rolls back overflow deletions when onlyKeepLatest cleanup fails mid-stream', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('gallery').disk('public').onlyKeepLatest(1),
      ],
    })

    const post = await Post.create({ title: 'Gallery' })
    const modelType = post.getRepository().definition.morphClass
    const modelId = String(post.get('id'))
    const originals = [
      {
        uuid: 'gallery-1',
        name: 'one',
        fileName: 'one.txt',
        order: 1,
        conversionsDisk: 'public',
        generatedConversions: {
          missing: {
            path: 'media/gallery-1/conversions/missing.txt',
          },
          skipped: {} as never,
        } as never,
      },
      {
        uuid: 'gallery-2',
        name: 'two',
        fileName: 'two.txt',
        order: 2,
        conversionsDisk: null as never,
        generatedConversions: null as never,
      },
      { uuid: 'gallery-3', name: 'three', fileName: 'three.txt', order: 3, conversionsDisk: 'public', generatedConversions: {} as never },
    ]

    for (const original of originals) {
      const path = `media/${original.uuid}/original/${original.fileName}`
      storageState.getDiskStore('public').set(path, Buffer.from(original.name))
      await Media.create({
        uuid: original.uuid,
        model_type: modelType,
        model_id: modelId,
        collection_name: 'gallery',
        name: original.name,
        file_name: original.fileName,
        disk: 'public',
        conversions_disk: original.conversionsDisk,
        mime_type: 'text/plain',
        extension: 'txt',
        size: 1,
        path,
        generated_conversions: original.generatedConversions,
        order_column: original.order,
      })
    }

    storageState.failDelete('public', `media/gallery-2/original/two.txt`)

    await expect(
      post.addMedia({ contents: Buffer.from('4'), fileName: 'four.txt' }).toMediaCollection('gallery'),
    ).rejects.toThrow('delete failed for public:')

    const items = await post.getMedia('gallery')
    expect(items.map(item => item.fileName)).toEqual(['one.txt', 'two.txt', 'three.txt'])
    expect(storageState.getDiskStore('public').has('media/gallery-1/original/one.txt')).toBe(true)
    expect(storageState.getDiskStore('public').has('media/gallery-2/original/two.txt')).toBe(true)
    expect(storageState.getDiskStore('public').has('media/gallery-3/original/three.txt')).toBe(true)
    expect([...storageState.getDiskStore('public').keys()].some(path => path.includes('four.txt'))).toBe(false)
  })

  it('cleans up uploaded files when conversion generation fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        if (conversion.name === 'thumb') {
          return {
            contents: Buffer.from('thumb'),
            fileName: 'thumb.webp',
            mimeType: 'image/webp',
          }
        }

        throw new Error('conversion failed')
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('uploads').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('uploads').format('webp'),
        conversion('card').performOnCollections('uploads').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Upload' })

    await expect(post.addMedia({
      contents: Buffer.from('orphan'),
      fileName: 'orphan.txt',
      mimeType: 'text/plain',
    }).toMediaCollection('uploads')).rejects.toThrow('conversion failed')

    expect(storageState.getDiskStore('public').size).toBe(0)
  })

  it('handles conversion executor edge cases and media item fallbacks', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        if (conversion.name === 'skip') {
          return null
        }

        return {
          contents: new Blob([Buffer.from('variant')]),
          fileName: 'variant',
          disk: 'broken',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('skip').performOnCollections('images'),
        conversion('broken').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Broken' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'image.txt',
      mimeType: 'text/plain',
    }).toMediaCollection('images')

    expect(media.getUrl('skip' as never)).toBeNull()
    expect(media.getPath('skip' as never)).toBeNull()
    expect(media.getPath('broken')).toBeNull()
    expect(media.getUrl('broken')).toBeNull()
    expect(media.getTemporaryUrl('skip' as never)).toBeNull()
    expect(media.getTemporaryUrl('broken')).toBeNull()

    const manual = await Media.create({
      uuid: 'manual',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'manual',
      file_name: 'manual.txt',
      disk: 'broken',
      conversions_disk: null as never,
      mime_type: null as never,
      extension: null as never,
      size: 1,
      path: 'manual/original.txt',
      generated_conversions: {
        broken: {
          path: 'manual/conversion.txt',
        },
        skipped: {} as never,
      } as never,
      order_column: 99,
    })

    const detachedItem = new MediaItem(manual)
    expect(detachedItem.record.file_name).toBe('manual.txt')
    expect(detachedItem.toJSON().file_name).toBe('manual.txt')
    expect(detachedItem.getUrl()).toBeNull()
    expect(detachedItem.getPath()).toBeNull()
    expect(detachedItem.getTemporaryUrl()).toBeNull()

    await detachedItem.delete()
    expect(storageState.getDiskStore('broken').has('manual/original.txt')).toBe(false)
    expect(storageState.getDiskStore('broken').has('manual/conversion.txt')).toBe(false)

    const publicManual = await Media.create({
      uuid: 'manual-2',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'manual-2',
      file_name: 'manual-2.txt',
      disk: 'public',
      conversions_disk: 's3',
      mime_type: 'text/plain',
      extension: 'txt',
      size: 1,
      path: 'manual-2/original.txt',
      generated_conversions: {
        fallback: {
          path: 'manual-2/fallback.txt',
        },
      } as never,
      order_column: 100,
    })

    const conversionDiskItem = new MediaItem(publicManual)
    expect(conversionDiskItem.getPath('fallback' as never)).toContain('/virtual/s3/')
  })

  it('supports remote uploads and selective regeneration', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input?: string | URL | Request) => {
      const url = String(input)

      if (url.includes('no-header')) {
        return new Response(await createImageBuffer(), {
          status: 200,
        })
      }

      return new Response(await createImageBuffer(), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
        },
      })
    }))

    let revision = 'v1'

    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`${revision}:${conversion.name}`),
          fileName: `${conversion.name}.txt`,
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
        collection('downloads').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
        conversion('card').performOnCollections('images'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote' })
      const media = await post
        .addMediaFromUrl('https://example.test/remote.jpg')
        .usingName('Remote Hero')
        .toMediaCollection('images')

      expect(media.record.name).toBe('Remote Hero')
      expect(media.fileName).toBe('remote.jpg')
      expect(media.getAvailableConversions()).toEqual(['thumb', 'card'])

      const thumbPath = media.record.generated_conversions.thumb?.path
      const cardPath = media.record.generated_conversions.card?.path
      expect(thumbPath).toBeTruthy()
      expect(cardPath).toBeTruthy()
      const resolvedThumbPath = thumbPath as string
      const resolvedCardPath = cardPath as string
      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedThumbPath)!)).toBe('v1:thumb')
      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedCardPath)!)).toBe('v1:card')

      revision = 'v2'
      await media.regenerate('thumb')

      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedThumbPath)!)).toBe('v2:thumb')
      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedCardPath)!)).toBe('v1:card')

      revision = 'v3'
      await post.regenerateMedia('images', 'card')

      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedCardPath)!)).toBe('v3:card')

      await expect(post.regenerateMedia('images', 'missing' as never)).rejects.toThrow('Unknown media conversion')

      const download = await post
        .addMedia('https://example.test')
        .toMediaCollection('downloads')

      expect(download.fileName).toBe('media.bin')
      await expect(post.regenerateMedia('downloads', 'thumb' as never)).rejects.toThrow('not registered for collection')

      const fallbackNamed = await post
        .addMediaFromUrl('%%%%')
        .toMediaCollection('downloads')

      expect(fallbackNamed.fileName).toBe('media.bin')

      const mimeOverride = await post
        .addMedia({
          url: 'https://example.test/override',
          mimeType: 'image/png',
        })
        .usingFileName('override.png')
        .toMediaCollection('downloads')

      expect(mimeOverride.mimeType).toBe('image/png')

      const noHeader = await post
        .addMediaFromUrl('https://example.test/no-header')
        .usingFileName('headerless.bin')
        .toMediaCollection('downloads')

      expect(noHeader.mimeType).toBeNull()

      revision = 'v4'
      await media.regenerate()

      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedThumbPath)!)).toBe('v4:thumb')
      expect(new TextDecoder().decode(storageState.getDiskStore('public').get(resolvedCardPath)!)).toBe('v4:card')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects oversized remote uploads before buffering the response body', async () => {
    const arrayBuffer = vi.fn(async () => createImageBuffer())

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-length': '10',
        'content-type': 'image/jpeg',
      }),
      arrayBuffer,
    } as unknown as Response)))

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(2),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Limit' })

      await expect(post.addMediaFromUrl('https://example.test/oversized.jpg').toMediaCollection('images'))
        .rejects.toThrow('exceeds the max size')
      expect(arrayBuffer).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects oversized remote uploads without content-length before buffering the response body', async () => {
    const arrayBuffer = vi.fn(async () => createImageBuffer())

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'image/jpeg',
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        },
      }),
      arrayBuffer,
    } as unknown as Response)))

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(2),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Stream Limit' })

      await expect(post.addMediaFromUrl('https://example.test/oversized-stream.jpg').toMediaCollection('images'))
        .rejects.toThrow('exceeds the max size')
      expect(arrayBuffer).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('streams headerless remote uploads within the max size without arrayBuffer()', async () => {
    const arrayBuffer = vi.fn(async () => createImageBuffer())
    const releaseLock = vi.fn()
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: undefined })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
      .mockResolvedValueOnce({ done: true, value: undefined })

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'image/jpeg',
      }),
      body: {
        getReader() {
          return {
            read,
            cancel: vi.fn(async () => undefined),
            releaseLock,
          }
        },
      },
      arrayBuffer,
    } as unknown as Response)))

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(4),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Stream Success' })
      const media = await post.addMediaFromUrl('https://example.test/streamed.jpg').toMediaCollection('images')

      expect(media.size).toBe(2)
      expect(media.mimeType).toBe('image/jpeg')
      expect(arrayBuffer).not.toHaveBeenCalled()
      expect(read).toHaveBeenCalledTimes(3)
      expect(releaseLock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips queued conversions during inline generation and regeneration before async workers process them', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(conversion.name),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))
    const queueHarness = createAsyncQueueHarness()

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')

    expect(media.getAvailableConversions()).toEqual(['card'])
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
    expect(queueHarness.queued).toHaveLength(1)

    await media.regenerate()

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1]?.[0].conversion.name).toBe('card')
    expect(queueHarness.queued).toHaveLength(2)
    expect(listRegisteredQueueJobs().map(job => job.name)).toContain(MEDIA_GENERATE_CONVERSIONS_JOB)
  })

  it('dispatches queued conversions and refreshes the media item when the sync queue runs immediately', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(conversion.name),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })
    ensureMediaQueueJobRegistered()

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Sync' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
    expect(generate.mock.calls[1]?.[0].conversion.name).toBe('thumb')
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    expect(await Storage.disk('public').get('media/' + media.record.uuid + '/conversions/thumb.txt')).toBe('thumb')

    await media.regenerate()

    expect(generate).toHaveBeenCalledTimes(4)
    expect(generate.mock.calls[2]?.[0].conversion.name).toBe('card')
    expect(generate.mock.calls[3]?.[0].conversion.name).toBe('thumb')
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
  })

  it('refreshes queued conversions after commit when the default sync queue runs inside a transaction', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(conversion.name),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })
    ensureMediaQueueJobRegistered()

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Sync Transaction' })
    const media = await DB.transaction(async () => {
      return await post.addMedia({
        contents: Buffer.from('image'),
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
      }).toMediaCollection('images')
    })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
    expect(generate.mock.calls[1]?.[0].conversion.name).toBe('thumb')
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    expect(await Storage.disk('public').get('media/' + media.record.uuid + '/conversions/thumb.txt')).toBe('thumb')
  })

  it('queues media conversion jobs for async workers and applies the queued conversion when the worker runs', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))
    const queueHarness = createAsyncQueueHarness()

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Async' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
    expect(media.getAvailableConversions()).toEqual(['card'])
    expect(queueHarness.queued).toHaveLength(1)
    expect(queueHarness.queued[0]).toMatchObject({
      name: MEDIA_GENERATE_CONVERSIONS_JOB,
      connection: 'redis',
      queue: 'media',
      payload: {
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      },
    })

    const result = await runQueueWorker({
      connection: 'redis',
      once: true,
    })

    expect(result).toMatchObject({
      processed: 1,
      released: 0,
      failed: 0,
      stoppedBecause: 'once',
    })

    await media.getEntity().refresh()

    expect(generate).toHaveBeenCalledTimes(2)
    expect(generate.mock.calls[1]?.[0].conversion.name).toBe('thumb')
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    expect(await Storage.disk('public').get('media/' + media.record.uuid + '/conversions/thumb.txt')).toBe('generated:thumb')
  })

  it('commits media attachments inside DB transactions before queued conversions are enqueued after commit', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })
    await createQueueTables()
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued In Transaction' })
    const media = await DB.transaction(async () => {
      return await post.addMedia({
        contents: Buffer.from('image'),
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
      }).toMediaCollection('images')
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
    expect(media.getAvailableConversions()).toEqual(['card'])
    expect(await DB.table('jobs').get()).toHaveLength(1)
  }, 500)

  it('rejects media transactions when post-commit queued conversion dispatch fails', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Failure' })

    await expect(DB.transaction(async () => {
      return await post.addMedia({
        contents: Buffer.from('image'),
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
      }).toMediaCollection('images')
    })).rejects.toThrow('failed to enqueue job')

    expect(await DB.table('media').get()).toHaveLength(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
  })

  it('does not enqueue queued conversions when the surrounding media transaction rolls back', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })
    await createQueueTables()
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
        conversion('card').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Rollback' })

    await expect(DB.transaction(async () => {
      await post.addMedia({
        contents: Buffer.from('image'),
        fileName: 'hero.jpg',
        mimeType: 'image/jpeg',
      }).toMediaCollection('images')

      throw new Error('rollback now')
    })).rejects.toThrow('rollback now')

    expect(await DB.table('media').get()).toHaveLength(0)
    expect(await DB.table('jobs').get()).toHaveLength(0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0].conversion.name).toBe('card')
  })

  it('reports queued conversion worker failures for unknown conversions and missing originals', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))
    const queueHarness = createAsyncQueueHarness()

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Failures' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')
    queueHarness.queued.length = 0
    const failures: Error[] = []

    await dispatchQueuedMediaConversions({
      mediaId: media.record.id,
      conversionNames: ['missing'],
    })

    const unknownResult = await runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed(event) {
        failures.push(event.error)
      },
    })

    expect(unknownResult.failed).toBe(1)
    expect(failures[0]?.message).toContain('Unknown media conversion')

    await Storage.disk('public').delete(media.record.path)

    await dispatchQueuedMediaConversions({
      mediaId: media.record.id,
      conversionNames: ['thumb'],
    })

    const missingOriginalResult = await runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed(event) {
        failures.push(event.error)
      },
    })

    expect(missingOriginalResult.failed).toBe(1)
    expect(failures[1]?.message).toContain('original file is missing')
  })

  it('treats missing media rows as a no-op queued conversion job', async () => {
    const generate = vi.fn(async () => ({
      contents: Buffer.from('generated'),
      fileName: 'thumb.txt',
      mimeType: 'text/plain',
    }))

    setMediaConversionExecutor({ generate })

    await expect(runMediaGenerateConversionsJob({
      mediaId: 999_999,
      conversionNames: ['thumb'],
    })).resolves.toEqual({
      status: 'missing-media',
      conversionNames: [],
    })
    expect(generate).not.toHaveBeenCalled()
  })

  it('defers the exported queued conversion helper until the surrounding transaction commits', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))
    const queueHarness = createAsyncQueueHarness()

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Helper Commit' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')

    expect(queueHarness.queued).toHaveLength(1)
    queueHarness.queued.length = 0

    await DB.transaction(async () => {
      await dispatchQueuedMediaConversions({
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      })

      expect(queueHarness.queued).toHaveLength(0)
    })

    expect(queueHarness.queued).toHaveLength(1)
    expect(queueHarness.queued[0]).toMatchObject({
      name: MEDIA_GENERATE_CONVERSIONS_JOB,
      payload: {
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      },
    })
  })

  it('does not dispatch the exported queued conversion helper when the surrounding transaction rolls back', async () => {
    const generate = vi.fn(async ({ conversion }: { conversion: { name: string } }) => ({
      contents: Buffer.from(`generated:${conversion.name}`),
      fileName: `${conversion.name}.txt`,
      mimeType: 'text/plain',
    }))
    const queueHarness = createAsyncQueueHarness()

    setMediaConversionExecutor({ generate })
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Helper Rollback' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
      mimeType: 'image/jpeg',
    }).toMediaCollection('images')

    expect(queueHarness.queued).toHaveLength(1)
    queueHarness.queued.length = 0

    await expect(DB.transaction(async () => {
      await dispatchQueuedMediaConversions({
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      })

      expect(queueHarness.queued).toHaveLength(0)
      throw new Error('rollback helper dispatch')
    })).rejects.toThrow('rollback helper dispatch')

    expect(queueHarness.queued).toHaveLength(0)
  })

  it('covers media queue helper validation, normalization, and idempotent registration', async () => {
    ensureMediaQueueJobRegistered()
    ensureMediaQueueJobRegistered()
    expect(listRegisteredQueueJobs().filter(job => job.name === MEDIA_GENERATE_CONVERSIONS_JOB)).toHaveLength(1)

    await expect(dispatchQueuedMediaConversions({
      mediaId: 'media-1',
      conversionNames: ['   ', ''],
    })).resolves.toBeUndefined()

    await expect(runMediaGenerateConversionsJob({
      mediaId: Number.NaN,
      conversionNames: ['thumb'],
    })).rejects.toThrow('finite media identifier')

    await expect(runMediaGenerateConversionsJob({
      mediaId: '   ',
      conversionNames: ['thumb'],
    })).rejects.toThrow('non-empty media identifier')

    await expect(runMediaGenerateConversionsJob({
      mediaId: 999_998,
      conversionNames: [' thumb ', 'thumb', ' card '],
    })).resolves.toEqual({
      status: 'missing-media',
      conversionNames: [],
    })
  })

  it('regenerates legacy conversions that fall back to the media disk', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('legacy-thumb'),
          fileName: 'thumb.txt',
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Legacy' })
    storageState.getDiskStore('public').set('media/legacy/original/legacy.jpg', Buffer.from('original'))
    storageState.getDiskStore('public').set('media/legacy/conversions/thumb.txt', Buffer.from('outdated'))

    const legacy = await Media.create({
      uuid: 'legacy',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'legacy',
      file_name: 'legacy.jpg',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'image/jpeg',
      extension: 'jpg',
      size: 8,
      path: 'media/legacy/original/legacy.jpg',
      generated_conversions: {
        thumb: {
          path: 'media/legacy/conversions/thumb.txt',
        },
      } as never,
      order_column: 1,
    })

    await new MediaItem(legacy).regenerate('thumb')

    expect(
      new TextDecoder().decode(storageState.getDiskStore('public').get('media/legacy/conversions/thumb.txt')!),
    ).toBe('legacy-thumb')
  })

  it('keeps existing conversions when regeneration fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Regenerate' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'image.txt',
      mimeType: 'text/plain',
    }).toMediaCollection('images')

    const thumbPath = media.record.generated_conversions.thumb?.path
    expect(thumbPath).toBeTruthy()
    expect(storageState.getDiskStore('public').has(thumbPath!)).toBe(true)

    setMediaConversionExecutor({
      async generate() {
        throw new Error('conversion failed')
      },
    })

    await expect(media.regenerate('thumb')).rejects.toThrow('conversion failed')
    expect(storageState.getDiskStore('public').has(thumbPath!)).toBe(true)
    expect(media.getEntity().get('generated_conversions').thumb?.path).toBe(thumbPath)
  })

  it('fails remote uploads when the download is unsuccessful', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response('missing', {
        status: 404,
        statusText: 'Not Found',
      })
    }))

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Broken Remote' })
      await expect(post.addMediaFromUrl('https://example.test/missing.jpg').toMediaCollection('images')).rejects.toThrow('Failed to download media')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps only the latest items when configured', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('gallery').disk('public').onlyKeepLatest(2),
      ],
    })

    const post = await Post.create({ title: 'Gallery' })

    await post.addMedia({ contents: Buffer.from('1'), fileName: 'one.txt' }).toMediaCollection('gallery')
    await post.addMedia({ contents: Buffer.from('2'), fileName: 'two.txt' }).toMediaCollection('gallery')
    await post.addMedia({ contents: Buffer.from('3'), fileName: 'three.txt' }).toMediaCollection('gallery')

    const items = await post.getMedia('gallery')
    expect(items).toHaveLength(2)
    expect(items.map(item => item.fileName)).toEqual(['two.txt', 'three.txt'])
  })

  it('regenerates detached media rows using fallback collection definitions', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('global'),
          fileName: 'global.txt',
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      conversions: [
        conversion('global'),
      ],
    })

    const post = await Post.create({ title: 'Detached' })
    storageState.getDiskStore('public').set('ghost/original.txt', Buffer.from('original'))
    storageState.getDiskStore('public').set('ghost/old.txt', Buffer.from('old'))

    const ghost = await Media.create({
      uuid: 'ghost',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'ghost',
      name: 'ghost',
      file_name: 'ghost.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'text/plain',
      extension: 'txt',
      size: 8,
      path: 'ghost/original.txt',
      generated_conversions: {
        old: {
          path: 'ghost/old.txt',
        },
        skipped: {} as never,
      } as never,
      order_column: 500,
    })

    const item = new MediaItem(ghost)
    await item.regenerate()

    expect(item.getAvailableConversions()).toEqual(['global'])
    expect(storageState.getDiskStore('public').has('media/ghost/conversions/global.txt')).toBe(true)
  })

  it('covers default disk, null metadata, and item fallback branches', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('variant'),
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('misc'),
      ],
      conversions: [
        conversion('copy').performOnCollections('misc'),
      ],
    })

    const post = await Post.create({ title: 'Misc' })
    const media = await post
      .addMedia(Buffer.from('original'))
      .usingFileName('raw')
      .toMediaCollection('misc')
    const blankName = await post
      .addMedia({
        contents: Buffer.from('blank'),
        fileName: '   ',
      })
      .toMediaCollection('misc')
    const implicitContentsName = await post
      .addMedia({
        contents: Buffer.from('implicit'),
      })
      .toMediaCollection('misc')
    const defaultName = await post
      .addMedia(Buffer.from('default'))
      .toMediaCollection('misc')

    expect(media.record.disk).toBe('public')
    expect(media.record.conversions_disk).toBe('public')
    expect(media.record.mime_type).toBeNull()
    expect(media.record.extension).toBeNull()
    expect(media.getPath('copy')).toContain('/virtual/public/')
    expect(blankName.fileName).toBe('media.bin')
    expect(implicitContentsName.fileName).toBe('media.bin')
    expect(defaultName.fileName).toBe('media.bin')

    const noConversions = await Media.create({
      uuid: 'manual-3',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-3',
      file_name: 'manual-3.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: null as never,
      extension: null as never,
      size: 1,
      path: 'manual-3/original.txt',
      generated_conversions: null as never,
      order_column: 101,
    })

    storageState.getDiskStore('public').set('manual-3/original.txt', Buffer.from('manual-3'))
    expect(new MediaItem(noConversions).getAvailableConversions()).toEqual([])
    await expect(new MediaItem(noConversions).regenerate('copy')).resolves.toBeInstanceOf(MediaItem)
    await new MediaItem(noConversions).delete()

    const nullDelete = await Media.create({
      uuid: 'manual-3-delete',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-3-delete',
      file_name: 'manual-3-delete.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: null as never,
      extension: null as never,
      size: 1,
      path: 'manual-3-delete/original.txt',
      generated_conversions: null as never,
      order_column: 101,
    })

    await new MediaItem(nullDelete).delete()

    const diskFallback = await Media.create({
      uuid: 'manual-4',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-4',
      file_name: 'manual-4.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'text/plain',
      extension: 'txt',
      size: 1,
      path: 'manual-4/original.txt',
      generated_conversions: {
        plain: {
          path: 'manual-4/plain.txt',
        },
      } as never,
      order_column: 102,
    })

    expect(new MediaItem(diskFallback).getPath('plain' as never)).toContain('/virtual/public/')

    await expect(media.regenerate('unknown' as never)).rejects.toThrow('Unknown media conversion')
    await expect(new MediaItem(diskFallback).regenerate('copy')).rejects.toThrow('original file is missing')
  })

  it('falls back to the private default disk when resolving the public disk throws', async () => {
    setMediaConversionExecutor({
      async generate() {
        return null
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('misc'),
      ],
    })

    const post = await Post.create({ title: 'Local default' })
    storageState.setDefaultDisk('local')

    const storageModule = await import('@holo-js/storage/runtime')
    const originalDisk = storageModule.Storage.disk
    vi.spyOn(storageModule.Storage, 'disk').mockImplementation((diskName?: string) => {
      if (diskName === 'public') {
        throw new Error('public disk missing')
      }

      return originalDisk.call(storageModule.Storage, diskName)
    })

    try {
      const media = await post.addMedia(Buffer.from('default')).toMediaCollection('misc')
      expect(media.record.disk).toBe('local')
      expect(media.record.conversions_disk).toBe('local')
    } finally {
      vi.restoreAllMocks()
      storageState.setDefaultDisk('public')
    }
  })
})
