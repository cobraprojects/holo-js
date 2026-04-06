import { syncQueueDriverFactory } from '../src'
import { runQueueDriverContractSuite } from './support/driver-contract'

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
