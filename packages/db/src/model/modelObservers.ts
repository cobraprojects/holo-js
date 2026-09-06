import type { AnyModelDefinition } from './types'

const additionalModelObservers = new WeakMap<AnyModelDefinition, Set<unknown>>()

export function registerModelObserver(
  definition: AnyModelDefinition,
  observer: unknown,
): void {
  const registered = additionalModelObservers.get(definition) ?? new Set()
  registered.add(observer)
  additionalModelObservers.set(definition, registered)
}

export function listModelObservers(
  definition: AnyModelDefinition,
): readonly unknown[] {
  return [
    ...definition.observers,
    ...(additionalModelObservers.get(definition) ?? []),
  ]
}
