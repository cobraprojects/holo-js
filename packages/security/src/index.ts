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
  input as createCsrfInput,
  isSecureRequest,
  protect,
  token as createCsrfToken,
  verify as verifyCsrfRequest,
} from './csrf'
import {
  apply as applyCors,
  cors,
  corsInternals,
  headers as createCorsHeaders,
  preflight as createCorsPreflightResponse,
} from './cors'
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
  HoloCorsConfig,
  HoloSecurityCsrfConfig,
  NormalizedHoloCorsConfig,
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
  cors,
  applyCors,
  createCorsHeaders,
  createCorsPreflightResponse,
  csrf,
  createCsrfCookie,
  createCsrfField,
  createCsrfInput,
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
  corsInternals,
  isSecureRequest,
}
export type {
  SecurityClearRateLimitOptions,
  SecurityClientConfig,
  SecurityCsrfFacade,
  SecurityCorsFacade,
  SecurityCsrfInput,
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
  cors,
  protect,
  defaultRateLimitKey,
  rateLimit,
  clearRateLimit,
  limit,
  ip,
})

export default security
