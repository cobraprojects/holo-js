import { isDeepStrictEqual } from 'node:util'
import { reportError } from '@holo-js/kernel/error-reporting'
import { releaseManagedResources, throwCapabilityFailures } from './capabilityLifetimes'

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

type ManagedResourceState = 'open' | 'draining' | 'closing'

type CloseFailureHandler = (error: unknown) => void

interface ManagedResourceEntry<TConfig, TValue> {
  readonly config: TConfig
  readonly value: TValue
  readonly lease: ResourceLease<TValue>
  pending: number
  state: ManagedResourceState
  onDrained?: () => void
  onFailure?: CloseFailureHandler
}

export function createManagedResources<TConfig, TValue extends ReleasableResource>(
  options: { readonly connect?: (value: TValue) => void | Promise<void> } = {},
): ManagedResources<TConfig, TValue> {
  let active: ManagedResourceEntry<TConfig, TValue>[] = []
  let retained: ManagedResourceEntry<TConfig, TValue>[] = []
  let claimed: ManagedResourceEntry<TConfig, TValue>[] = []
  let opened: ManagedResourceEntry<TConfig, TValue>[] = []
  let disposing = false
  let disposalFailures: unknown[] = []
  const releasing = new Set<Promise<void>>()

  const findSameConfig = (entries: readonly ManagedResourceEntry<TConfig, TValue>[], config: TConfig) =>
    entries.find(entry => isDeepStrictEqual(entry.config, config))

  const track = (promise: Promise<void>): void => {
    releasing.add(promise)
    promise.then(() => releasing.delete(promise))
  }

  const reportReplacedResourceFailure: CloseFailureHandler = error => reportError(error, {
    capability: 'runtime',
    operation: 'releaseReplacedResource',
  })

  const startClose = (entry: ManagedResourceEntry<TConfig, TValue>, onFailure: CloseFailureHandler): Promise<void> => {
    entry.state = 'closing'
    retained = retained.filter(candidate => candidate !== entry)
    return releaseManagedResources([entry.value])
      .catch(onFailure)
      .finally(() => entry.onDrained?.())
  }

  const retireEntry = (entry: ManagedResourceEntry<TConfig, TValue>, onFailure: CloseFailureHandler): Promise<void> => {
    if (entry.pending === 0) return startClose(entry, onFailure)
    entry.state = 'draining'
    entry.onFailure = onFailure
    return new Promise<void>(resolve => { entry.onDrained = resolve })
  }

  const finishOperation = (entry: ManagedResourceEntry<TConfig, TValue>): void => {
    entry.pending -= 1
    if (entry.pending !== 0 || entry.state === 'closing') return
    const awaitingClose = entry.state === 'draining' || (retained.includes(entry) && !claimed.includes(entry))
    if (awaitingClose) track(startClose(entry, entry.onFailure ?? reportReplacedResourceFailure))
  }

  const createEntry = (config: TConfig, value: TValue): ManagedResourceEntry<TConfig, TValue> => {
    const entry: ManagedResourceEntry<TConfig, TValue> = {
      config,
      value,
      pending: 0,
      state: 'open',
      lease: {
        value,
        hold<TResult>(operation: () => TResult): TResult {
          if (entry.state === 'closing') throw new Error('[@holo-js/core] The managed resource is closed.')
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
      await Promise.all(idle.map(entry => retireEntry(entry, reportReplacedResourceFailure)))
    },
    async discard() {
      const revivedIdle = claimed.filter(entry => retained.includes(entry) && entry.pending === 0)
      retained = retained.filter(entry => !revivedIdle.includes(entry))
      const entries = [...opened, ...revivedIdle]
      claimed = []
      opened = []
      const failures: unknown[] = []
      await Promise.all(entries.map(entry => retireEntry(entry, error => { failures.push(error) })))
      throwCapabilityFailures(failures)
    },
    async dispose() {
      disposing = true
      disposalFailures = []
      const entries = [...active, ...retained, ...claimed, ...opened]
      active = []
      retained = []
      claimed = []
      opened = []
      for (const entry of entries) {
        track(retireEntry(entry, error => { disposalFailures.push(error) }))
      }
      while (releasing.size > 0) await Promise.all([...releasing])
      throwCapabilityFailures(disposalFailures)
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
