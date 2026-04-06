import { databaseQueueDriverFactory } from './drivers/database'
import { queueDbFailedJobStore } from './failed'

export function createQueueDbRuntimeOptions() {
  return Object.freeze({
    driverFactories: [databaseQueueDriverFactory],
    failedJobStore: queueDbFailedJobStore,
  })
}
