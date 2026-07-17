import { queueRuntimeInternals, syncQueueDriverFactory } from '../src'
import { runQueueDriverContractSuite } from './support/driver-contract'
import { runSharedQueueDriverContract } from './support/shared-driver-contract'

runQueueDriverContractSuite({
  label: 'sync',
  createDriver(context) {
    return syncQueueDriverFactory.create({
      name: 'sync',
      driver: 'sync',
      queue: 'default',
    }, context)
  },
})

runSharedQueueDriverContract({
  label: '@holo-js/queue sync',
  expected: { name: 'sync', driver: 'sync', mode: 'sync' },
  createDriver() {
    return syncQueueDriverFactory.create({
      name: 'sync',
      driver: 'sync',
      queue: 'default',
    }, queueRuntimeInternals.createQueueDriverFactoryContext())
  },
})
