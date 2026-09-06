import { DatabaseError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import { areModelEventsMuted } from './eventState'
import { listModelObservers } from './modelObservers'
import type { ModelDefinition, ModelLifecycleEventName } from './types'

export class ModelEventDispatcher<TTable extends TableDefinition> {
  constructor(
    private readonly definition: ModelDefinition<TTable>,
    private readonly repository: object,
  ) {}

  async dispatchCancelable(
    eventName: Extract<ModelLifecycleEventName, 'saving' | 'creating' | 'updating' | 'deleting' | 'restoring' | 'forceDeleting'>,
    entity: Entity<TTable>,
  ): Promise<void> {
    const results = await this.dispatch(eventName, entity, true)
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

  private resolveHandlers(eventName: ModelLifecycleEventName): readonly ((...args: unknown[]) => unknown)[] {
    const observers = listModelObservers(this.definition).map((observer) => {
      return typeof observer === 'function' ? new (observer as new () => unknown)() : observer
    })
    const observerHandlers = observers
      .map(observer => (observer as Record<string, unknown>)[eventName])
      .filter((handler): handler is (...args: unknown[]) => unknown => typeof handler === 'function')
    return [...(this.definition.events[eventName] ?? []), ...observerHandlers]
  }
}
