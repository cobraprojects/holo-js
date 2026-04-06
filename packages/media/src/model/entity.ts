import { Entity } from '@holo-js/db'
import { getMediaDefinition } from '../registry'
import { Media } from './Media'
import { MediaAdder, type MediaSourceInput } from './adder'
import { MediaItem } from './item'
import type { TableDefinition } from '@holo-js/db'

type MediaEntityPrototype = Entity<TableDefinition> & {
  addMedia(source: MediaSourceInput): MediaAdder
  addMediaFromUrl(url: string): MediaAdder
  getMedia(collectionName?: string): Promise<MediaItem[]>
  getMediaUrls(collectionName?: string, conversionName?: string): Promise<string[]>
  getMediaPaths(collectionName?: string, conversionName?: string): Promise<string[]>
  getFirstMedia(collectionName?: string): Promise<MediaItem | null>
  getFirstMediaUrl(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstMediaPath(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstTemporaryUrl(
    collectionName?: string,
    conversionName?: string,
    options?: { expiresAt?: Date | number | string, expiresIn?: number },
  ): Promise<string | null>
  hasMedia(collectionName?: string): Promise<boolean>
  clearMediaCollection(collectionName?: string): Promise<void>
  regenerateMedia(collectionName?: string, conversions?: string | readonly string[]): Promise<void>
  __holoMediaInstalled__?: true
}

function getOwnerKey(entity: Entity<TableDefinition>): string | null {
  const ownerDefinition = entity.getRepository().definition
  const ownerId = entity.get(ownerDefinition.primaryKey as never)
  if (ownerId === null || typeof ownerId === 'undefined') {
    return null
  }

  return String(ownerId)
}

function createQuery(
  entity: Entity<TableDefinition>,
  collectionName?: string,
) {
  const mediaDefinition = getMediaDefinition(entity)
  if (!mediaDefinition) {
    return null
  }

  const ownerDefinition = entity.getRepository().definition
  const ownerId = getOwnerKey(entity)
  if (!ownerId) {
    return null
  }

  let query = Media.query()
    .where('model_type', ownerDefinition.morphClass)
    .where('model_id', ownerId)

  if (collectionName) {
    query = query.where('collection_name', collectionName)
  }

  return query.orderBy('order_column').orderBy('id')
}

export function installEntityMediaMethods(): void {
  const prototype = Entity.prototype as MediaEntityPrototype
  if (prototype.__holoMediaInstalled__) {
    return
  }

  prototype.__holoMediaInstalled__ = true

  prototype.addMedia = function addMedia(source: MediaSourceInput) {
    return new MediaAdder(this, source)
  }

  prototype.addMediaFromUrl = function addMediaFromUrl(url: string) {
    return new MediaAdder(this, { url })
  }

  prototype.getMedia = async function getMedia(collectionName?: string) {
    const query = createQuery(this, collectionName)
    if (!query) {
      return []
    }

    const rows = await query.get()
    return rows.map((row) => {
      return new MediaItem(row, this)
    })
  }

  prototype.getMediaUrls = async function getMediaUrls(
    collectionName?: string,
    conversionName?: string,
  ) {
    const items = await this.getMedia(collectionName)
    return items
      .map(item => item.getUrl(conversionName))
      .filter((value): value is string => typeof value === 'string')
  }

  prototype.getMediaPaths = async function getMediaPaths(
    collectionName?: string,
    conversionName?: string,
  ) {
    const items = await this.getMedia(collectionName)
    return items
      .map(item => item.getPath(conversionName))
      .filter((value): value is string => typeof value === 'string')
  }

  prototype.getFirstMedia = async function getFirstMedia(collectionName?: string) {
    const query = createQuery(this, collectionName)
    if (!query) {
      return null
    }

    const row = await query.first()
    return row ? new MediaItem(row, this) : null
  }

  prototype.getFirstMediaUrl = async function getFirstMediaUrl(
    collectionName?: string,
    conversionName?: string,
  ) {
    const item = await this.getFirstMedia(collectionName)
    return item?.getUrl(conversionName) ?? null
  }

  prototype.getFirstMediaPath = async function getFirstMediaPath(
    collectionName?: string,
    conversionName?: string,
  ) {
    const item = await this.getFirstMedia(collectionName)
    return item?.getPath(conversionName) ?? null
  }

  prototype.getFirstTemporaryUrl = async function getFirstTemporaryUrl(
    collectionName?: string,
    conversionName?: string,
    options?: { expiresAt?: Date | number | string, expiresIn?: number },
  ) {
    const item = await this.getFirstMedia(collectionName)
    return item?.getTemporaryUrl(conversionName, options) ?? null
  }

  prototype.hasMedia = async function hasMedia(collectionName?: string) {
    const query = createQuery(this, collectionName)
    if (!query) {
      return false
    }

    return query.exists()
  }

  prototype.clearMediaCollection = async function clearMediaCollection(collectionName?: string) {
    const items = await this.getMedia(collectionName)
    for (const item of items) {
      await item.delete()
    }
  }

  prototype.regenerateMedia = async function regenerateMedia(
    collectionName?: string,
    conversions?: string | readonly string[],
  ) {
    const items = await this.getMedia(collectionName)
    for (const item of items) {
      await item.regenerate(conversions as never)
    }
  }
}
