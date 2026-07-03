import { nextDefinitionName, realtimeDefinitionInternals } from '../definition'
import { createRealtimeDatabaseContext } from './execution'
import {
  handleBatchedDatabaseInvalidation,
  handleDatabaseInvalidation,
  scheduleSubscriptionRefresh,
} from './invalidation'
import { createRefreshKey } from './refresh-key'
import { getRuntimeState } from './state'
import { stableStringify } from './stable-stringify'

export const realtimeRuntimeInternals = {
  REALTIME_DEFINITION_MARKER: realtimeDefinitionInternals.REALTIME_DEFINITION_MARKER,
  createRealtimeDatabaseContext,
  createRefreshKey,
  getRuntimeState,
  handleBatchedDatabaseInvalidation,
  handleDatabaseInvalidation,
  nextDefinitionName,
  scheduleSubscriptionRefresh,
  stableStringify,
}
