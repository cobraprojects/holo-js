import { afterEach, describe, expect, it } from 'vitest'
import { configureQueueRuntime, getQueueRuntime, resetQueueRuntime } from '@holo-js/queue'
import { createQueueDbRuntimeOptions } from '../src'

afterEach(() => {
  resetQueueRuntime()
})

describe('@holo-js/queue-db runtime integration', () => {
  it('creates runtime options that register the database driver and failed store', () => {
    const runtimeOptions = createQueueDbRuntimeOptions()

    expect(runtimeOptions.driverFactories).toHaveLength(1)
    expect(runtimeOptions.driverFactories[0]?.driver).toBe('database')
    expect(runtimeOptions.failedJobStore).toBeDefined()
  })

  it('applies the database queue runtime options without extra transaction hooks', () => {
    configureQueueRuntime({
      ...createQueueDbRuntimeOptions(),
    })

    expect(getQueueRuntime().config.default).toBe('sync')
    expect(getQueueRuntime().drivers.size).toBe(0)
  })
})
