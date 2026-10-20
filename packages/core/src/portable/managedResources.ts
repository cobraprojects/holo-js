import { isDeepStrictEqual } from 'node:util'
import { reportError } from '@holo-js/kernel/error-reporting'
import { releaseManagedResources } from './capabilityLifetimes'

export interface ReleasableResource {
  close?(): void | Promise<void>
  disconnect?(): void | Promise<void>
}

export interface HeldResource {
  hold<TResult>(operation: () => TResult): TResult
}

export interface ResourceLease<TValue> extends HeldResource {
  readonly value: TValue
}

export interface ManagedResources<TConfig, TValue extends ReleasableResource> {
  acquire(config: TConfig, create: (config: TConfig) => TValue): Promise<ResourceLease<TValue>>
  commit(): Promise<void>
  discard(): Promise<void>
  dispose(): Promise<void>
}

interface ManagedResourceEntry<TConfig, TValue> {
  readonly config: TConfig
  readonly value: TValue
  readonly lease: ResourceLease<TValue>
  pending: number
  onClosed?: () => void
}

export function createManagedResources<TConfig, TValue extends ReleasableResource>(
  options: { readonly connect?: (value: TValue) => void | Promise<void> } = {},
): ManagedResources<TConfig, TValue> {
  let active: ManagedResourceEntry<TConfig, TValue>[] = []
  let retained: ManagedResourceEntry<TConfig, TValue>[] = []
  let claimed: ManagedResourceEntry<TConfig, TValue>[] = []
  let opened: ManagedResourceEntry<TConfig, TValue>[] = []
  let draining: ManagedResourceEntry<TConfig, TValue>[] = []
  let disposing = false
  const releasing = new Set<Promise<void>>()

  const findSameConfig = (entries: readonly ManagedResourceEntry<TConfig, TValue>[], config: TConfig) =>
    entries.find(entry => isDeepStrictEqual(entry.config, config))

  const closeWhenIdle = (entry: ManagedResourceEntry<TConfig, TValue>): void => {
    retained = retained.filter(candidate => candidate !== entry)
    draining = draining.filter(candidate => candidate !== entry)
    const release = releaseManagedResources([entry.value])
      .catch(error => reportError(error, {
        capability: 'runtime',
        operation: 'releaseReplacedResource',
      }))
      .finally(() => {
        releasing.delete(release)
        entry.onClosed?.()
      })
    releasing.add(release)
  }

  const finishOperation = (entry: ManagedResourceEntry<TConfig, TValue>): void => {
    entry.pending -= 1
    const awaitingIdle = retained.includes(entry) || draining.includes(entry)
    if (entry.pending === 0 && awaitingIdle && !claimed.includes(entry)) closeWhenIdle(entry)
  }

  const createEntry = (config: TConfig, value: TValue): ManagedResourceEntry<TConfig, TValue> => {
    const entry: ManagedResourceEntry<TConfig, TValue> = {
      config,
      value,
      pending: 0,
      lease: {
        value,
        hold<TResult>(operation: () => TResult): TResult {
          entry.pending += 1
          let result: TResult
          try {
            result = operation()
          } catch (error) {
            finishOperation(entry)
            throw error
          }
          if (result instanceof Promise) {
            result.finally(() => finishOperation(entry)).catch(() => undefined)
          } else {
            finishOperation(entry)
          }
          return result
        },
      },
    }
    return entry
  }

  return {
    async acquire(config, create) {
      if (disposing) throw new Error('[@holo-js/core] Managed resources are disposed; acquire a new registry instead.')
      const reusable = findSameConfig(claimed, config)
        ?? findSameConfig(active, config)
        ?? findSameConfig(retained, config)
      if (reusable) {
        if (!claimed.includes(reusable)) claimed.push(reusable)
        return reusable.lease
      }

      const entry = createEntry(config, create(config))
      opened.push(entry)
      await options.connect?.(entry.value)
      claimed.push(entry)
      return entry.lease
    },
    async commit() {
      const previouslyOpen = [...active, ...retained]
      active = claimed
      claimed = []
      opened = []
      retained = previouslyOpen.filter(entry => !active.includes(entry))
      const idle = retained.filter(entry => entry.pending === 0)
      retained = retained.filter(entry => entry.pending > 0)
      await releaseManagedResources(idle.map(entry => entry.value))
    },
    async discard() {
      const revivedIdle = claimed.filter(entry => retained.includes(entry) && entry.pending === 0)
      retained = retained.filter(entry => !revivedIdle.includes(entry))
      const values = [...opened, ...revivedIdle].map(entry => entry.value)
      claimed = []
      opened = []
      await releaseManagedResources(values)
    },
    async dispose() {
      disposing = true
      const entries = [...active, ...retained, ...claimed, ...opened]
      active = []
      retained = []
      claimed = []
      opened = []
      const idle = entries.filter(entry => entry.pending === 0)
      for (const entry of entries.filter(candidate => candidate.pending > 0)) {
        draining.push(entry)
        releasing.add(new Promise<void>(resolve => { entry.onClosed = resolve }))
      }
      await Promise.all([...releasing])
      await releaseManagedResources(idle.map(entry => entry.value))
    },
  }
}

export function holdOperations<TTarget extends object>(target: TTarget, lease: HeldResource): TTarget {
  return new Proxy(target, {
    get(source, property) {
      const value: unknown = Reflect.get(source, property, source)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => lease.hold(() => Reflect.apply(value, source, args))
    },
  })
}
