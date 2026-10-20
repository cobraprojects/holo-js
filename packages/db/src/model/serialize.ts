type SerializableModel = {
  toJSON(): unknown
}

type MaterializeSerializedValue<TValue>
  = TValue extends Date
    ? Date
    : TValue extends readonly (infer TItem)[]
      ? MaterializeSerializedValue<TItem>[]
      : TValue extends (...args: never[]) => unknown
    ? TValue
    : TValue extends object
      ? { [K in keyof TValue]: MaterializeSerializedValue<TValue[K]> }
      : TValue

export type SerializeModels<TValue>
  = TValue extends Date
    ? Date
    : TValue extends SerializableModel
      ? MaterializeSerializedValue<ReturnType<TValue['toJSON']>>
      : TValue extends readonly (infer TItem)[]
        ? SerializeModels<TItem>[]
        : TValue extends object
          ? { [K in keyof TValue]: SerializeModels<TValue[K]> }
          : TValue

function isSerializableModel(value: object): value is SerializableModel {
  return typeof (value as SerializableModel).toJSON === 'function'
}

export function modelNeedsSerialization(definition: {
  readonly accessors: object
  readonly appended: readonly string[]
  readonly casts: object
  readonly hidden: readonly string[]
  readonly visible: readonly string[]
}): boolean {
  return Object.keys(definition.accessors).length > 0
    || Object.keys(definition.casts).length > 0
    || definition.appended.length > 0
    || definition.hidden.length > 0
    || definition.visible.length > 0
}

export function serializeModels<TValue>(value: TValue): SerializeModels<TValue> {
  if (value instanceof Date || value === null || typeof value !== 'object') {
    return value as SerializeModels<TValue>
  }

  if (isSerializableModel(value)) {
    return serializeModels(value.toJSON()) as SerializeModels<TValue>
  }

  if (Array.isArray(value)) {
    return value.map(item => serializeModels(item)) as SerializeModels<TValue>
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeModels(entry)]),
  ) as SerializeModels<TValue>
}
