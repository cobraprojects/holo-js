import { Storage } from '@holo-js/storage/runtime'
import { connectionAsyncContext } from '@holo-js/db'
import { resolveQueuedConversionNames, regenerateMediaEntityConversions } from './conversions'
import { dispatchQueuedMediaConversionsForModel } from '../queue'
import { requireMediaDefinition, requireMediaDefinitionForMorphClass } from '../registry'
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

type StoredVariantSnapshot = VariantRecord & {
  readonly contents: Uint8Array
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

function registerDeletedVariantRollbackRestore(
  snapshots: readonly StoredVariantSnapshot[],
): void {
  const active = connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return
  }

  active.afterRollback(async () => {
    for (const snapshot of [...snapshots].reverse()) {
      /* v8 ignore next -- rollback cleanup failures are intentionally swallowed. */
      await Storage.disk(snapshot.disk).put(snapshot.path, snapshot.contents).catch(() => undefined)
    }
  })
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
    const deletedSnapshots: StoredVariantSnapshot[] = []

    try {
      for (const variant of this.resolveStoredVariants()) {
        const disk = Storage.disk(variant.disk)
        const contents = await disk.getBytes(variant.path)
        await disk.delete(variant.path)

        if (contents) {
          deletedSnapshots.push({
            ...variant,
            contents,
          })
        }
      }

      await this.entity.delete()
      registerDeletedVariantRollbackRestore(deletedSnapshots)
      this.owner?.forgetRelation('media')
    } catch (error) {
      for (const snapshot of deletedSnapshots.reverse()) {
        /* v8 ignore next -- rollback cleanup failures are intentionally swallowed. */
        await Storage.disk(snapshot.disk).put(snapshot.path, snapshot.contents).catch(() => undefined)
      }

      throw error
    }
  }

  async regenerate(
    conversions?: TConversionName | readonly TConversionName[],
  ): Promise<this> {
    await regenerateMediaEntityConversions({
      media: this.entity,
      owner: this.owner,
      conversions,
    })

    const definition = this.owner
      ? requireMediaDefinition(this.owner)
      : requireMediaDefinitionForMorphClass(String(this.entity.get('model_type')))
    const queuedConversions = resolveQueuedConversionNames({
      definition,
      collectionName: String(this.entity.get('collection_name')),
      requestedConversions: conversions,
    })
    await dispatchQueuedMediaConversionsForModel({
      mediaId: this.entity.get('id'),
      conversionNames: queuedConversions,
    }, async () => {
      await this.entity.refresh()
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

  private resolveStoredVariants(): VariantRecord[] {
    const variants: VariantRecord[] = [{
      path: this.entity.get('path'),
      disk: this.entity.get('disk'),
    }]
    const fallbackDisk = this.entity.get('conversions_disk') ?? this.entity.get('disk')
    const conversions = (this.entity.get('generated_conversions') ?? {}) as GeneratedMediaConversions

    for (const value of Object.values(conversions)) {
      if (!value?.path) {
        continue
      }

      variants.push({
        path: value.path,
        disk: value.disk ?? fallbackDisk,
      })
    }

    return variants
  }
}
