import {
  createFileRateLimitStoreConfig,
  createMemoryRateLimitStoreConfig,
  createRedisRateLimitStoreConfig,
  defineRateLimiter,
  defineSecurityRuntimeBindings,
  ip,
  limit,
  securityInternals,
} from './contracts'
import {
  csrf,
  csrfInternals,
  cookie as createCsrfCookie,
  field as createCsrfField,
  protect,
  token as createCsrfToken,
  verify as verifyCsrfRequest,
} from './csrf'
import {
  clearRateLimit,
  defaultRateLimitKey,
  rateLimit,
  rateLimitInternals,
} from './rate-limit'
import {
  createRateLimitStoreFromConfig,
  securityStoreInternals,
} from './store'
import {
  createFileRateLimitStore,
  fileRateLimitDriverInternals,
} from './drivers/file'
import {
  createMemoryRateLimitStore,
  memoryRateLimitDriverInternals,
} from './drivers/memory'
import {
  createRedisRateLimitStore,
  redisRateLimitDriverInternals,
} from './drivers/redis'
import {
  configureSecurityRuntime,
  getSecurityRuntime,
  getSecurityRuntimeBindings,
  resetSecurityRuntime,
  SecurityRuntimeNotConfiguredError,
  securityRuntimeInternals,
} from './runtime'

export { defineSecurityConfig } from '@holo-js/config'
export type {
  HoloSecurityConfig,
  HoloSecurityCsrfConfig,
  HoloSecurityRateLimitConfig,
  NormalizedHoloSecurityConfig,
  NormalizedHoloSecurityCsrfConfig,
  NormalizedHoloSecurityRateLimitConfig,
  NormalizedSecurityLimiterConfig,
  SecurityLimiterConfig,
  SecurityRateLimitContext,
  SecurityRateLimitDriver,
  SecurityRateLimitFileConfig,
  SecurityRateLimitKeyResolver,
  SecurityRateLimitMemoryConfig,
  SecurityRateLimitRedisConfig,
} from '@holo-js/config'

export {
  createFileRateLimitStoreConfig,
  createFileRateLimitStore,
  createMemoryRateLimitStoreConfig,
  createMemoryRateLimitStore,
  createRedisRateLimitStoreConfig,
  createRedisRateLimitStore,
  createRateLimitStoreFromConfig,
  csrf,
  createCsrfCookie,
  createCsrfField,
  createCsrfToken,
  defineRateLimiter,
  defineSecurityRuntimeBindings,
  defaultRateLimitKey,
  ip,
  limit,
  protect,
  rateLimit,
  clearRateLimit,
  fileRateLimitDriverInternals,
  securityStoreInternals,
  securityInternals,
  memoryRateLimitDriverInternals,
  rateLimitInternals,
  redisRateLimitDriverInternals,
  verifyCsrfRequest,
  csrfInternals,
}
export type {
  SecurityClearRateLimitOptions,
  SecurityClientBindings,
  SecurityClientConfig,
  SecurityCsrfFacade,
  SecurityCsrfField,
  SecurityDefaultRateLimitKeyResolver,
  SecurityProtectOptions,
  SecurityRateLimitCallOptions,
  SecurityRateLimitBucketSnapshot,
  SecurityRateLimitHitResult,
  SecurityRateLimitRedisDriverAdapter,
  SecurityRateLimitStoreFactoryOptions,
  SecurityRateLimitStore,
  SecurityRuntimeBindings,
  SecurityRuntimeFacade,
} from './contracts'
export {
  SecurityCsrfError,
  SecurityRateLimitError,
} from './contracts'
export {
  configureSecurityRuntime,
  getSecurityRuntime,
  getSecurityRuntimeBindings,
  resetSecurityRuntime,
  SecurityRuntimeNotConfiguredError,
  securityRuntimeInternals,
}

const security = Object.freeze({
  configureSecurityRuntime,
  getSecurityRuntime,
  getSecurityRuntimeBindings,
  resetSecurityRuntime,
  csrf,
  protect,
  defaultRateLimitKey,
  rateLimit,
  clearRateLimit,
  limit,
  ip,
})

export default security
