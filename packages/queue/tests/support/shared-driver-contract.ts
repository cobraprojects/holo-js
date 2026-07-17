import { describe, expect, it } from 'vitest'
import type { QueueDriver } from '../../src'

export type SharedQueueDriverContractOptions = {
  readonly label: string
  readonly expected: {
    readonly name: string
    readonly driver: string
    readonly mode: 'async' | 'sync'
  }
  createDriver(): QueueDriver | Promise<QueueDriver>
}

export function runSharedQueueDriverContract(options: SharedQueueDriverContractOptions): void {
  describe(`${options.label} shared queue driver contract`, () => {
    it('exposes canonical metadata and clears an empty queue selection', async () => {
      const driver = await options.createDriver()
      try {
        expect({ name: driver.name, driver: driver.driver, mode: driver.mode }).toEqual(options.expected)
        await expect(driver.clear({ queueNames: ['contract-empty'] })).resolves.toBe(0)
      } finally {
        await driver.close()
      }
    })
  })
}
