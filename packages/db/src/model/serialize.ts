type SerializableModel = {
  toJSON(): unknown
}

export type SerializeModels<TValue>
  = TValue extends Date
    ? Date
    : TValue extends SerializableModel
      ? ReturnType<TValue['toJSON']>
      : TValue extends readonly (infer TItem)[]
        ? SerializeModels<TItem>[]
        : TValue extends object
          ? { [K in keyof TValue]: SerializeModels<TValue[K]> }
          : TValue

function isSerializableModel(value: unknown): value is SerializableModel {
  return Boolean(value && typeof value === 'object' && typeof (value as SerializableModel).toJSON === 'function')
}

export function serializeModels<TValue>(value: TValue): SerializeModels<TValue> {
  if (value instanceof Date || value === null || typeof value !== 'object') {
    return value as SerializeModels<TValue>
  }

  if (isSerializableModel(value)) {
    return value.toJSON() as SerializeModels<TValue>
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeModels(item)) as SerializeModels<TValue>
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeModels(entry)]),
  ) as SerializeModels<TValue>
}
