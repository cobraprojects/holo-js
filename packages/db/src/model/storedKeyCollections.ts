import { canonicalStoredKey } from './entityRuntime'

function dictionaryKey(value: unknown): unknown {
  return value instanceof Date ? value : canonicalStoredKey(value)
}

export class StoredKeyMap<TValue> {
  readonly #entries = new Map<unknown, [unknown, TValue]>()

  constructor(entries: Iterable<readonly [unknown, TValue]> = []) {
    for (const [key, value] of entries) this.set(key, value)
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: unknown): TValue | undefined {
    return this.#entries.get(dictionaryKey(key))?.[1]
  }

  has(key: unknown): boolean {
    return this.#entries.has(dictionaryKey(key))
  }

  set(key: unknown, value: TValue): this {
    this.#entries.set(dictionaryKey(key), [key, value])
    return this
  }

  *keys(): IterableIterator<unknown> {
    for (const [key] of this.#entries.values()) yield key
  }

  *values(): IterableIterator<TValue> {
    for (const [, value] of this.#entries.values()) yield value
  }

  *entries(): IterableIterator<[unknown, TValue]> {
    for (const [key, value] of this.#entries.values()) yield [key, value]
  }

  [Symbol.iterator](): IterableIterator<[unknown, TValue]> {
    return this.entries()
  }
}

export class StoredKeySet {
  readonly #keys = new Map<unknown, unknown>()

  constructor(values: Iterable<unknown> = []) {
    for (const value of values) this.add(value)
  }

  add(value: unknown): this {
    this.#keys.set(dictionaryKey(value), value)
    return this
  }

  has(value: unknown): boolean {
    return this.#keys.has(dictionaryKey(value))
  }

  *values(): IterableIterator<unknown> {
    yield* this.#keys.values()
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    return this.values()
  }
}
