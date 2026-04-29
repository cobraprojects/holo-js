type JsonSerializable = {
  toJSON(): unknown
}

type HoloModelEntityLike = JsonSerializable & {
  getRepository(): unknown
  toAttributes(): Record<string, unknown>
}

type HoloModelCollectionLike = JsonSerializable & {
  modelKeys(): unknown[]
  toQuery(): unknown
}

export type SerializedSvelteKitData<TValue>
  = TValue extends JsonSerializable
    ? ReturnType<TValue['toJSON']>
    : TValue extends readonly (infer TItem)[]
      ? SerializedSvelteKitData<TItem>[]
      : TValue extends Date
        ? Date
        : TValue extends object
          ? { [K in keyof TValue]: SerializedSvelteKitData<TValue[K]> }
          : TValue

type HoloTransportEncoder = {
  encode: (value: unknown) => false | unknown[] | Record<string, unknown>
  decode: (value: unknown[] | Record<string, unknown>) => unknown
}

export type SvelteKitTransportDefinition = Readonly<{
  HoloModel: HoloTransportEncoder
  HoloCollection: HoloTransportEncoder
}>

function isHoloModelEntityLike(value: unknown): value is HoloModelEntityLike {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as HoloModelEntityLike).getRepository === 'function'
    && typeof (value as HoloModelEntityLike).toAttributes === 'function'
    && typeof (value as HoloModelEntityLike).toJSON === 'function',
  )
}

function isHoloModelCollectionLike(value: unknown): value is HoloModelCollectionLike {
  const candidate = value as unknown as HoloModelCollectionLike
  return Boolean(
    Array.isArray(value)
    && typeof candidate.modelKeys === 'function'
    && typeof candidate.toQuery === 'function'
    && typeof candidate.toJSON === 'function',
  )
}

export function serializeSvelteKitData<TValue>(value: TValue): SerializedSvelteKitData<TValue> {
  if (isHoloModelEntityLike(value) || isHoloModelCollectionLike(value)) {
    return value.toJSON() as SerializedSvelteKitData<TValue>
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeSvelteKitData(item)) as SerializedSvelteKitData<TValue>
  }

  if (value instanceof Date || value === null || typeof value !== 'object') {
    return value as SerializedSvelteKitData<TValue>
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeSvelteKitData(entry)]),
  ) as SerializedSvelteKitData<TValue>
}

export const holoSvelteKitTransport: SvelteKitTransportDefinition = {
  HoloModel: {
    encode(value) {
      return isHoloModelEntityLike(value)
        ? value.toJSON() as Record<string, unknown>
        : false
    },
    decode(value) {
      return value
    },
  },
  HoloCollection: {
    encode(value) {
      return isHoloModelCollectionLike(value)
        ? value.toJSON() as unknown[]
        : false
    },
    decode(value) {
      return value
    },
  },
}
