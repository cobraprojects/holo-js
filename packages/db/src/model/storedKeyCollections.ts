import { isCanonicalIntegerText, readFractionalDecimalKey, readIntegralDecimalKey } from '../schema/normalization'
import { canonicalStoredKey } from './entityRuntime'

export interface StoredKeyOptions {
  readonly numeric?: boolean
}

function integerIdentity(value: unknown): unknown {
  if (isCanonicalIntegerText(value)) {
    return Number.isSafeInteger(Number(value)) ? Number(value) : BigInt(value)
  }

  return typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value) : value
}

function fractionalKey(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return `numeric:${String(value)}`
  }

  const fraction = readFractionalDecimalKey(value)
  return fraction === undefined ? undefined : `numeric:${fraction}`
}

function dictionaryKey(value: unknown, numeric: boolean): unknown {
  if (value instanceof Date) {
    return value
  }

  if (!numeric) {
    return canonicalStoredKey(integerIdentity(value))
  }

  return fractionalKey(value) ?? canonicalStoredKey(integerIdentity(readIntegralDecimalKey(value)))
}

export class StoredKeyMap<TValue> {
  readonly #entries = new Map<unknown, [unknown, TValue]>()
  readonly #numeric: boolean

  constructor(entries: Iterable<readonly [unknown, TValue]> = [], options: StoredKeyOptions = {}) {
    this.#numeric = options.numeric === true
    for (const [key, value] of entries) this.set(key, value)
  }

  get options(): StoredKeyOptions {
    return { numeric: this.#numeric }
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: unknown): TValue | undefined {
    return this.#entries.get(dictionaryKey(key, this.#numeric))?.[1]
  }

  has(key: unknown): boolean {
    return this.#entries.has(dictionaryKey(key, this.#numeric))
  }

  set(key: unknown, value: TValue): this {
    this.#entries.set(dictionaryKey(key, this.#numeric), [key, value])
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
  readonly #numeric: boolean

  constructor(values: Iterable<unknown> = [], options: StoredKeyOptions = {}) {
    this.#numeric = options.numeric === true
    for (const value of values) this.add(value)
  }

  add(value: unknown): this {
    this.#keys.set(dictionaryKey(value, this.#numeric), value)
    return this
  }

  has(value: unknown): boolean {
    return this.#keys.has(dictionaryKey(value, this.#numeric))
  }

  *values(): IterableIterator<unknown> {
    yield* this.#keys.values()
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    return this.values()
  }
}
