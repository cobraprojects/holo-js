export interface MediaCollectionDefinition<TName extends string = string> {
  readonly kind: 'collection'
  readonly name: TName
  readonly diskName?: string
  readonly conversionsDiskName?: string
  readonly singleFile: boolean
  readonly onlyKeepLatest?: number
  readonly acceptedMimeTypes: readonly string[]
  readonly acceptedExtensions: readonly string[]
  readonly maxFileSize?: number
}

export interface MediaCollectionBuilder<TName extends string = string> {
  readonly kind: 'collection'
  readonly name: TName
  readonly definition: MediaCollectionDefinition<TName>
  disk(diskName: string): MediaCollectionBuilder<TName>
  conversionsDisk(diskName: string): MediaCollectionBuilder<TName>
  singleFile(): MediaCollectionBuilder<TName>
  onlyKeepLatest(limit: number): MediaCollectionBuilder<TName>
  acceptsMimeTypes(mimeTypes: readonly string[]): MediaCollectionBuilder<TName>
  acceptsExtensions(extensions: readonly string[]): MediaCollectionBuilder<TName>
  maxSize(bytes: number): MediaCollectionBuilder<TName>
}

export interface NormalizedMediaCollectionDefinition<TName extends string = string> extends MediaCollectionDefinition<TName> {
  readonly disk?: string
  readonly conversionsDisk?: string
  readonly singleFile: boolean
  readonly acceptedMimeTypes: readonly string[]
  readonly acceptedExtensions: readonly string[]
  readonly maxSize?: number
}

function decorateCollection<TName extends string>(
  definition: MediaCollectionDefinition<TName>,
): MediaCollectionBuilder<TName> {
  const clone = (
    overrides: Partial<MediaCollectionDefinition<TName>>,
  ): MediaCollectionBuilder<TName> => decorateCollection(Object.freeze({
    ...definition,
    ...overrides,
  }))

  return Object.freeze({
    kind: definition.kind,
    name: definition.name,
    definition,
    disk(diskName: string) {
      return clone({ diskName: diskName.trim() || undefined })
    },
    conversionsDisk(diskName: string) {
      return clone({ conversionsDiskName: diskName.trim() || undefined })
    },
    singleFile() {
      return clone({ singleFile: true, onlyKeepLatest: 1 })
    },
    onlyKeepLatest(limit: number) {
      return clone({
        onlyKeepLatest: Math.max(1, Math.floor(limit)),
      })
    },
    acceptsMimeTypes(mimeTypes: readonly string[]) {
      return clone({
        acceptedMimeTypes: Object.freeze(
          mimeTypes
            .map(mimeType => mimeType.trim())
            .map(mimeType => mimeType.toLowerCase())
            .filter(Boolean),
        ),
      })
    },
    acceptsExtensions(extensions: readonly string[]) {
      return clone({
        acceptedExtensions: Object.freeze(
          extensions
            .map(extension => extension.trim().replace(/^\./, '').toLowerCase())
            .filter(Boolean),
        ),
      })
    },
    maxSize(bytes: number) {
      return clone({
        maxFileSize: Math.max(1, Math.floor(bytes)),
      })
    },
  })
}

export function collection<const TName extends string>(
  name: TName,
): MediaCollectionBuilder<TName> {
  return decorateCollection(Object.freeze({
    kind: 'collection' as const,
    name,
    singleFile: false,
    acceptedMimeTypes: Object.freeze([]),
    acceptedExtensions: Object.freeze([]),
  }))
}

export function normalizeCollectionDefinitions<
  TName extends string = string,
>(
  definitions: readonly MediaCollectionDefinition<TName>[],
): readonly NormalizedMediaCollectionDefinition<TName>[] {
  return Object.freeze(definitions.map((definition) => {
    return Object.freeze({
      ...definition,
      disk: definition.diskName?.trim() || undefined,
      conversionsDisk: definition.conversionsDiskName?.trim() || undefined,
      singleFile: Boolean(definition.singleFile),
      onlyKeepLatest: typeof definition.onlyKeepLatest === 'number'
        ? Math.max(1, Math.floor(definition.onlyKeepLatest))
        : undefined,
      acceptedMimeTypes: Object.freeze(
        definition.acceptedMimeTypes
          .map(mimeType => mimeType.trim())
          .map(mimeType => mimeType.toLowerCase())
          .filter(Boolean),
      ),
      acceptedExtensions: Object.freeze(
        definition.acceptedExtensions
          .map(extension => extension.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean),
      ),
      maxSize: typeof definition.maxFileSize === 'number'
        ? Math.max(1, Math.floor(definition.maxFileSize))
        : undefined,
    })
  }))
}
