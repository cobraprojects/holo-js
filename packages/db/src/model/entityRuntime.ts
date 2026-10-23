import { SecurityError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { ModelRecord, ModelRelationName, RelationMap, RelationMethodsOf } from './types'
import type { Entity } from './Entity'

const reservedAttributeNames: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export function assertAttributeNameAllowed(name: string): void {
  if (reservedAttributeNames.has(name)) {
    throw new SecurityError(`Attribute "${name}" is reserved and cannot be assigned.`)
  }
}

export function ownEntry<TValue>(record: Readonly<Record<string, TValue>>, key: string): TValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

export type EntityConstructor = {
  new<
    TTable extends TableDefinition = TableDefinition,
    TRelations extends RelationMap = RelationMap,
  >(
    repository: unknown,
    attributes: Partial<ModelRecord<TTable>>,
    exists?: boolean,
  ): Entity<TTable, TRelations>
  prototype: Entity<TableDefinition, RelationMap>
}

export function valuesAreEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  if (isComparableBinaryView(left) && isComparableBinaryView(right)) {
    if (left.byteLength !== right.byteLength) {
      return false
    }

    const leftBytes = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    const rightBytes = new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
    for (let index = 0; index < leftBytes.length; index += 1) {
      if (leftBytes[index] !== rightBytes[index]) {
        return false
      }
    }

    return true
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => valuesAreEqual(value, right[index]))
  }

  if (
    left
    && right
    && typeof left === 'object'
    && typeof right === 'object'
    && Object.getPrototypeOf(left) === Object.getPrototypeOf(right)
  ) {
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord)
    const rightKeys = Object.keys(rightRecord)

    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    if (
      leftKeys.some(key => !Object.prototype.hasOwnProperty.call(rightRecord, key))
      || rightKeys.some(key => !Object.prototype.hasOwnProperty.call(leftRecord, key))
    ) {
      return false
    }

    return leftKeys.every(key => valuesAreEqual(leftRecord[key], rightRecord[key]))
  }

  return false
}

export function canonicalStoredKey(value: unknown): unknown {
  if (isComparableBinaryView(value)) {
    return `binary:${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')}`
  }

  if (value instanceof Date) {
    return `date:${value.getTime()}`
  }

  switch (typeof value) {
    case 'string':
      return `string:${value}`
    case 'number':
      return `number:${value}`
    case 'bigint':
      return `bigint:${value}`
    case 'boolean':
      return `boolean:${value}`
    case 'object':
      return canonicalObjectKey(value)
    default:
      return value
  }
}

function canonicalObjectKey(value: object | null): unknown {
  if (value === null || !(Array.isArray(value) || isPlainObject(value))) {
    return value
  }

  try {
    return `json:${JSON.stringify(value)}`
  } catch {
    return value
  }
}

export function snapshotAttributes<TAttributes extends object>(attributes: TAttributes): TAttributes {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, snapshotAttributeValue(value)])) as TAttributes
}

function snapshotAttributeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return new Date(value.getTime())
  }

  if (isComparableBinaryView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }

  if (Array.isArray(value)) {
    return value.map(snapshotAttributeValue)
  }

  if (value && typeof value === 'object' && isPlainObject(value)) {
    const copy = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: snapshotAttributeValue(nested), enumerable: true, writable: true, configurable: true })
    }
    return copy
  }

  return value
}

function isComparableBinaryView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

type EntityPropertyHost<TRelations extends RelationMap> = {
  hasRelation(name: string): boolean
  getRelation<TRelation = unknown>(name: string): TRelation
  relation<K extends ModelRelationName<TRelations>>(name: K): RelationMethodsOf<TRelations[K]>
  setRelation(name: string, value: unknown): unknown
  get(key: string): unknown
  set(key: string, value: unknown): unknown
}

type EntityPropertyRepository = {
  definition?: {
    table?: {
      columns?: Record<string, unknown>
    }
    relations?: Record<string, unknown>
  }
  getRelationNames?(): readonly string[]
  resolveRelationProperty?(entity: unknown, key: string): unknown
}

export function initializeEntityModelProperties<TRelations extends RelationMap>(
  entity: EntityPropertyHost<TRelations>,
  repo: EntityPropertyRepository | undefined,
): void {
  const columns = repo?.definition?.table?.columns
  if (columns && typeof columns === 'object') {
    for (const key of Object.keys(columns)) {
      if (key in entity) {
        continue
      }

      Object.defineProperty(entity, key, {
        configurable: true,
        enumerable: true,
        get: () => entity.get(key),
        set: (value: unknown) => {
          entity.set(key, value)
        },
      })
    }
  }

  const relationNames = typeof repo?.getRelationNames === 'function'
    ? repo.getRelationNames()
    : Object.keys(repo?.definition?.relations ?? {})

  for (const key of relationNames) {
    if (key in entity) {
      continue
    }

    Object.defineProperty(entity, key, {
      configurable: true,
      enumerable: false,
      get: () => {
        if (entity.hasRelation(key)) {
          return entity.getRelation(key)
        }

        const relationMethod = (() => entity.relation(key as ModelRelationName<TRelations>)) as (() => RelationMethodsOf<TRelations[ModelRelationName<TRelations>]>) & PromiseLike<unknown> & {
          catch?: <TResult = never>(onRejected?: (reason: unknown) => TResult | PromiseLike<TResult>) => Promise<unknown | TResult>
          finally?: (onFinally?: () => void) => Promise<unknown>
        }

        const loadRelation = () => {
          if (typeof repo?.resolveRelationProperty !== 'function') {
            return Promise.resolve(undefined)
          }

          try {
            return Promise.resolve(repo.resolveRelationProperty(entity, key))
          } catch (error) {
            return Promise.reject(error)
          }
        }

        relationMethod.then = (onFulfilled, onRejected) => loadRelation().then(onFulfilled, onRejected)
        relationMethod.catch = (onRejected) => loadRelation().catch(onRejected)
        relationMethod.finally = (onFinally) => loadRelation().finally(onFinally)

        return relationMethod
      },
      set: (value: unknown) => {
        entity.setRelation(key, value)
      },
    })
  }
}
