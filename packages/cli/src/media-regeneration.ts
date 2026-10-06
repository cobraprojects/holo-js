import type * as MediaModule from '@holo-js/media'
import type { Storage } from '@holo-js/storage/runtime'

type MediaModelDefinition = {
  readonly name: string
  readonly morphClass?: string
}

export type MediaRegenerationOptions = {
  readonly models: readonly string[]
  readonly ids: readonly number[]
  readonly only: readonly string[]
  readonly onlyMissing: boolean
}

export async function regenerateMediaConversions(
  runtime: { readonly media: typeof MediaModule, readonly storage: typeof Storage },
  models: readonly MediaModelDefinition[],
  options: MediaRegenerationOptions,
): Promise<{ regenerated: number, skipped: number }> {
  const { Media, MediaItem, getMediaDefinitionForMorphClass, requireMediaDefinitionForMorphClass } = runtime.media
  const selected = options.models.map(name => {
    const model = models.find(model => model.name === name || model.morphClass === name)
    if (!model) throw new Error(`Unknown model "${name}".`)
    const morphClass = model.morphClass ?? model.name
    requireMediaDefinitionForMorphClass(morphClass)
    return morphClass
  })
  let query = Media.query()
  const definitions = models
    .filter(model => selected.length === 0 || selected.includes(model.morphClass ?? model.name))
    .map(model => getMediaDefinitionForMorphClass(model.morphClass ?? model.name))
  for (const name of options.only) {
    if (!definitions.some(definition => definition?.conversionsByName[name])) {
      throw new Error(`Unknown media conversion "${name}".`)
    }
  }
  if (selected.length) query = query.whereIn('model_type', selected)
  if (options.ids.length) query = query.whereIn('id', [...options.ids])
  let regenerated = 0
  let skipped = 0

  await query.chunkById(100, async records => {
    for (const record of records) {
      const definition = requireMediaDefinitionForMorphClass(record.get('model_type'))
      const collectionName = record.get('collection_name')
      const applicable = definition.conversions.filter(conversion =>
        (conversion.collections.length === 0 || conversion.collections.includes(collectionName))
        && (options.only.length === 0 || options.only.includes(conversion.name)),
      )
      const conversions: string[] = []
      for (const conversion of applicable) {
        const stored = record.get('generated_conversions')[conversion.name]
        const disk = stored?.disk ?? record.get('conversions_disk') ?? record.get('disk')
        if (!options.onlyMissing || !stored || !await runtime.storage.disk(disk).exists(stored.path)) {
          conversions.push(conversion.name)
        }
      }
      if (conversions.length === 0) {
        skipped++
        continue
      }
      await new MediaItem(record).regenerate(conversions)
      regenerated++
    }
  })

  return { regenerated, skipped }
}
