import { describe, expect, it } from 'vitest'
import * as dbRuntime from '@holo-js/db'
import * as core from '../src'
import * as portable from '../src/portable/dbRuntime'

describe('core db runtime bootstrap', () => {
  it('preserves the core db runtime re-export contract', () => {
    expect(portable.createRuntimeConnectionOptions).toBe(dbRuntime.createRuntimeConnectionOptions)
    expect(portable.resolveRuntimeConnectionManagerOptions).toBe(dbRuntime.resolveRuntimeConnectionManagerOptions)
    expect(core.createRuntimeConnectionOptions).toBe(dbRuntime.createRuntimeConnectionOptions)
    expect(core.resolveRuntimeConnectionManagerOptions).toBe(dbRuntime.resolveRuntimeConnectionManagerOptions)
  })
})
