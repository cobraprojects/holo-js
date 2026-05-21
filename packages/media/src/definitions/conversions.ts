export type MediaConversionFormat = 'avif' | 'jpeg' | 'jpg' | 'png' | 'webp'
export type MediaConversionFit = 'contain' | 'cover' | 'fill' | 'inside' | 'outside'

export interface MediaConversionDefinition<
  TName extends string = string,
  TCollectionName extends string = string,
> {
  readonly kind: 'conversion'
  readonly name: TName
  readonly collections: readonly TCollectionName[]
  readonly width?: number
  readonly height?: number
  readonly fit?: MediaConversionFit
  readonly format?: MediaConversionFormat
  readonly quality?: number
  readonly queued: boolean
}

export interface MediaConversionBuilder<
  TName extends string = string,
  TCollectionName extends string = string,
> {
  readonly kind: 'conversion'
  readonly name: TName
  readonly definition: MediaConversionDefinition<TName, TCollectionName>
  performOnCollections<const TNextCollectionName extends string>(
    ...collections: readonly TNextCollectionName[]
  ): MediaConversionBuilder<TName, TCollectionName | TNextCollectionName>
  width(pixels: number): MediaConversionBuilder<TName, TCollectionName>
  height(pixels: number): MediaConversionBuilder<TName, TCollectionName>
  fit(mode: MediaConversionFit): MediaConversionBuilder<TName, TCollectionName>
  format(format: MediaConversionFormat): MediaConversionBuilder<TName, TCollectionName>
  quality(value: number): MediaConversionBuilder<TName, TCollectionName>
  queued(): MediaConversionBuilder<TName, TCollectionName>
  nonQueued(): MediaConversionBuilder<TName, TCollectionName>
}

export interface NormalizedMediaConversionDefinition<
  TName extends string = string,
  TCollectionName extends string = string,
> extends MediaConversionDefinition<TName, TCollectionName> {
  readonly collections: readonly TCollectionName[]
  readonly queued: boolean
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`[Holo Media] Media conversion ${fieldName} must be a finite number.`)
  }

  return Math.max(1, Math.floor(value))
}

function normalizeQuality(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error('[Holo Media] Media conversion quality must be a finite number.')
  }

  return Math.max(1, Math.min(100, Math.floor(value)))
}

function decorateConversion<
  TName extends string,
  TCollectionName extends string,
>(
  definition: MediaConversionDefinition<TName, TCollectionName>,
): MediaConversionBuilder<TName, TCollectionName> {
  const clone = <TNextCollectionName extends string = TCollectionName>(
    overrides: Partial<MediaConversionDefinition<TName, TNextCollectionName>>,
  ): MediaConversionBuilder<TName, TNextCollectionName> => decorateConversion(Object.freeze({
    ...definition,
    ...overrides,
  }) as MediaConversionDefinition<TName, TNextCollectionName>)

  return Object.freeze({
    kind: definition.kind,
    name: definition.name,
    definition,
    performOnCollections<const TNextCollectionName extends string>(
      ...collections: readonly TNextCollectionName[]
    ) {
      return clone<TCollectionName | TNextCollectionName>({
        collections: Object.freeze(
          collections.filter(Boolean),
        ) as readonly (TCollectionName | TNextCollectionName)[],
      })
    },
    width(pixels: number) {
      return clone({
        width: normalizePositiveInteger(pixels, 'width'),
      })
    },
    height(pixels: number) {
      return clone({
        height: normalizePositiveInteger(pixels, 'height'),
      })
    },
    fit(mode: MediaConversionFit) {
      return clone({ fit: mode })
    },
    format(format: MediaConversionFormat) {
      return clone({ format })
    },
    quality(value: number) {
      return clone({
        quality: normalizeQuality(value),
      })
    },
    queued() {
      return clone({ queued: true })
    },
    nonQueued() {
      return clone({ queued: false })
    },
  })
}

export function conversion<const TName extends string>(
  name: TName,
): MediaConversionBuilder<TName, never> {
  return decorateConversion(Object.freeze({
    kind: 'conversion' as const,
    name,
    collections: Object.freeze([]),
    queued: false,
  }))
}

export function normalizeConversionDefinitions<
  TName extends string = string,
  TCollectionName extends string = string,
>(
  definitions: readonly MediaConversionDefinition<TName, TCollectionName>[],
): readonly NormalizedMediaConversionDefinition<TName, TCollectionName>[] {
  return Object.freeze(definitions.map((definition) => {
    return Object.freeze({
      ...definition,
      collections: Object.freeze(
        definition.collections.filter(Boolean),
      ),
      width: typeof definition.width === 'number'
        ? normalizePositiveInteger(definition.width, 'width')
        : undefined,
      height: typeof definition.height === 'number'
        ? normalizePositiveInteger(definition.height, 'height')
        : undefined,
      quality: typeof definition.quality === 'number'
        ? normalizeQuality(definition.quality)
        : undefined,
      queued: Boolean(definition.queued),
    })
  }))
}
