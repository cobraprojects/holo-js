import type { TableDefinition } from '../schema/types'
import type { ModelRecord, ModelRelationName, RelationMap, RelationMethodsOf } from './types'
import type { Entity } from './Entity'

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

  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
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
