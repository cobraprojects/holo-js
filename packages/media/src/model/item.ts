import { Storage } from '@holo-js/storage/runtime'
import { deleteMediaItems } from './mutation'
import { regenerateMediaEntityConversions } from './conversions'
import type { Media, GeneratedMediaConversions } from './Media'
import type {
  Entity,
  ModelRecord,
  TableDefinition,
} from '@holo-js/db'

type MediaRecord = ModelRecord<typeof Media.definition.table>
type VariantRecord = {
  readonly path: string
  readonly disk: string
}

function toUrlPath(url: string): string {
  if (url.startsWith('/')) {
    return url
  }

  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return `/${url.replace(/^\/+/, '')}`
  }
}

export class MediaItem<
  TCollectionName extends string = string,
  TConversionName extends string = string,
  TEntity extends Entity<TableDefinition> = Entity<TableDefinition>,
> {
  constructor(
    private readonly entity: Entity<typeof Media.definition.table>,
    private readonly owner?: TEntity,
  ) {}

  get record(): MediaRecord {
    return this.entity.toAttributes()
  }

  get collectionName(): TCollectionName {
    return this.entity.get('collection_name') as TCollectionName
  }

  get fileName(): string {
    return this.entity.get('file_name')
  }

  get mimeType(): string | null {
    return this.entity.get('mime_type')
  }

  get size(): number {
    return this.entity.get('size')
  }

  getEntity(): Entity<typeof Media.definition.table> {
    return this.entity
  }

  getAvailableConversions(): readonly TConversionName[] {
    const conversions = this.entity.get('generated_conversions') as GeneratedMediaConversions | null
    return Object.freeze(
      Object.keys(conversions ?? {}) as TConversionName[],
    )
  }

  getPath(conversion?: TConversionName): string | null {
    const url = this.getUrl(conversion)
    return url ? toUrlPath(url) : null
  }

  getUrl(conversion?: TConversionName): string | null {
    const variant = this.resolveVariant(conversion)
    if (!variant) {
      return null
    }

    try {
      return Storage.disk(variant.disk).url(variant.path)
    } catch {
      return null
    }
  }

  getTemporaryUrl(
    conversion?: TConversionName,
    options?: { expiresAt?: Date | number | string, expiresIn?: number },
  ): string | null {
    const variant = this.resolveVariant(conversion)
    if (!variant) {
      return null
    }

    try {
      return Storage.disk(variant.disk).temporaryUrl(variant.path, options)
    } catch {
      return null
    }
  }

  async delete(): Promise<void> {
    await deleteMediaItems([this], this.owner)
  }

  async regenerate(
    conversions?: TConversionName | readonly TConversionName[],
  ): Promise<this> {
    await regenerateMediaEntityConversions({
      media: this.entity,
      owner: this.owner,
      conversions,
    })

    return this
  }

  toJSON(): MediaRecord {
    return this.entity.toJSON()
  }

  private resolveVariant(
    conversion?: TConversionName,
  ): VariantRecord | null {
    if (!conversion) {
      return {
        path: this.entity.get('path'),
        disk: this.entity.get('disk'),
      }
    }

    const conversions = this.entity.get('generated_conversions') as GeneratedMediaConversions | null
    const variant = conversions?.[conversion]
    if (!variant?.path) {
      return null
    }

    return {
      path: variant.path,
      disk: variant.disk ?? this.entity.get('conversions_disk') ?? this.entity.get('disk'),
    }
  }

}
