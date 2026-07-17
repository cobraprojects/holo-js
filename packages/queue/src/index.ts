import type { HoloQueueConfig } from './contracts'

function defineConfig<TConfig extends object>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

export function defineQueueConfig<TConfig extends HoloQueueConfig>(config: TConfig): Readonly<TConfig> {
  return defineConfig(config)
}

export { defineJob, isQueueJobDefinition, normalizeQueueJobDefinition, queueJobInternals } from './contracts'
export type {
  DefinedQueueJobDefinition,
  ExportedQueueJobDefinition,
  QueueAsyncDriver,
  NormalizedQueueConnectionConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  NormalizedQueuePluginConnectionConfig,
  QueueSharedRedisConfig,
  QueueSharedRedisConnectionConfig,
  NormalizedQueueRedisConnectionConfig,
  NormalizedQueueSyncConnectionConfig,
  NormalizedHoloQueueConfig,
  QueueConnectionFacade,
  QueueClearInput,
  QueueConnectionConfig,
  QueueDelayValue,
  QueueDispatchCompletedHook,
  QueueDispatchFailedHook,
  QueueDatabaseConnectionConfig,
  QueueDispatchOptions,
  QueueDispatchResult,
  QueueDriver,
  QueueDriverDispatchResult,
  QueueDriverFactory,
  QueueDriverFactoryContext,
  QueueEnqueueResult,
  QueueFailedJobRecord,
  QueueFailedJobStore,
  QueueFailedStoreConfig,
  QueueJobContext,
  QueueJobContextOverrides,
  QueueJobDefinition,
  QueueJobEnvelope,
  QueueJsonValue,
  QueuePendingDispatch,
  QueuePayloadFor,
  QueuePluginConnectionConfig,
  QueueRedisConnectionConfig,
  QueueRegisteredJob,
  QueueReleaseOptions,
  QueueReserveInput,
  QueueResultFor,
  QueueReservedJob,
  QueueRuntimeBinding,
  QueueSyncDriver,
  QueueSyncConnectionConfig,
  QueueWorkerHooks,
  QueueWorkerJobEvent,
  QueueWorkerOptions,
  QueueWorkerResult,
  QueueWorkerRunOptions,
  RegisterableQueueJobDefinition,
  RegisterQueueJobOptions,
  HoloQueueJobRegistry,
  HoloQueueConfig,
} from './contracts'
export {
  DEFAULT_DATABASE_QUEUE_TABLE,
  DEFAULT_FAILED_JOBS_CONNECTION,
  DEFAULT_FAILED_JOBS_TABLE,
  DEFAULT_QUEUE_BLOCK_FOR,
  DEFAULT_QUEUE_CONNECTION,
  DEFAULT_QUEUE_NAME,
  DEFAULT_QUEUE_RETRY_AFTER,
  DEFAULT_QUEUE_SLEEP,
  normalizeQueueConfig,
  queueInternals,
  holoQueueDefaults,
} from './config'
export {
  getRegisteredQueueJob,
  listRegisteredQueueJobs,
  queueRegistryInternals,
  registerQueueJob,
  registerQueueJobs,
  resetQueueRegistry,
  unregisterQueueJob,
} from './registry'
export {
  syncQueueDriverFactory,
  syncQueueDriverInternals,
} from './drivers/sync'
export {
  configureQueueRuntime,
  dispatch,
  dispatchSync,
  getQueueRuntime,
  Queue,
  queueRuntimeInternals,
  QueueReleaseUnsupportedError,
  resetQueueRuntime,
  shutdownQueueRuntime,
  useQueueConnection,
  loadQueuePluginDrivers,
} from './runtime'
export {
  loadQueuePluginDriverFactories,
  resetQueuePluginDriverFactories,
} from './plugins'
export {
  flushFailedQueueJobs,
  forgetFailedQueueJob,
  listFailedQueueJobs,
  persistFailedQueueJob,
  queueFailedInternals,
  QueueFailedStoreError,
  retryFailedQueueJobs,
} from './failed'
export {
  clearQueueConnection,
  queueWorkerInternals,
  QueueWorkerTimeoutError,
  QueueWorkerUnsupportedDriverError,
  runQueueWorker,
} from './worker'
