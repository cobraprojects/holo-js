import { DatabaseError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import { snapshotAttributes } from './entityRuntime'
import { areModelEventsMuted } from './eventState'
import { listModelObservers } from './modelObservers'
import type { ModelDefinition, ModelLifecycleEventName } from './types'

function prototypeDefinesHandler(observer: object, eventName: string): boolean {
  for (let target: object | null = (observer as { prototype?: object }).prototype ?? null; target && target !== Object.prototype; target = Object.getPrototypeOf(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, eventName)
    if (descriptor) return typeof descriptor.value === 'function'
  }
  return false
}

function observerHandles(observer: unknown, eventName: string): boolean {
  if (typeof observer !== 'function') {
    return typeof (observer as Record<string, unknown> | null)?.[eventName] === 'function'
  }

  if (prototypeDefinesHandler(observer, eventName)) return true
  const instance = new (observer as new () => Record<string, unknown>)()
  return typeof instance[eventName] === 'function'
}

export class ModelEventDispatcher<TTable extends TableDefinition> {
  constructor(
    private readonly definition: ModelDefinition<TTable>,
    private readonly repository: object,
  ) {}

  async dispatchCancelable(
    eventName: Extract<ModelLifecycleEventName, 'saving' | 'creating' | 'updating' | 'deleting' | 'restoring' | 'forceDeleting'>,
    entity: Entity<TTable>,
    afterHandler: (entity: Entity<TTable>, before: Record<string, unknown>) => void,
  ): Promise<void> {
    const results: unknown[] = []
    if (!areModelEventsMuted()) {
      for (const handler of this.resolveHandlers(eventName)) {
        const before = snapshotAttributes(entity.toAttributes())
        results.push(await handler(entity, this.repository))
        afterHandler(entity, before)
      }
    }
    if (results.includes(false)) {
      throw new DatabaseError(
        `${this.definition.name} ${eventName} event cancelled the operation.`,
        'MODEL_EVENT_CANCELLED',
      )
    }
  }

  async dispatch(
    eventName: ModelLifecycleEventName,
    entity: Entity<TTable>,
    collectResults = false,
  ): Promise<unknown[]> {
    if (areModelEventsMuted()) return []
    const results: unknown[] = []
    for (const handler of this.resolveHandlers(eventName)) {
      const result = await handler(entity, this.repository)
      if (collectResults) results.push(result)
    }
    return results
  }

  dispatchSync(eventName: Extract<ModelLifecycleEventName, 'replicating'>, entity: Entity<TTable>): void {
    if (areModelEventsMuted()) return
    for (const handler of this.resolveHandlers(eventName)) handler(entity, this.repository)
  }

  hasHandlers(eventName: ModelLifecycleEventName): boolean {
    const handlers = this.definition.events[eventName]
    if (handlers && handlers.length > 0) return true
    return listModelObservers(this.definition).some(observer => observerHandles(observer, eventName))
  }

  private resolveHandlers(eventName: ModelLifecycleEventName): readonly ((...args: unknown[]) => unknown)[] {
    const observers = listModelObservers(this.definition).map((observer) => {
      return typeof observer === 'function' ? new (observer as new () => unknown)() : observer
    })
    const observerHandlers = observers
      .map(observer => (observer as Record<string, unknown>)[eventName])
      .filter((handler): handler is (...args: unknown[]) => unknown => typeof handler === 'function')
    return [...(this.definition.events[eventName] ?? []) as readonly ((...args: unknown[]) => unknown)[], ...observerHandlers]
  }
}
