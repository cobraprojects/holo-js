import {
  getDefaultSecurityClientConfig,
  readSecurityClientConfigFromCookies,
  securityClientConfigInternals,
} from './client-config'
import type { SecurityClientConfig } from './contracts'

export type {
  SecurityClientConfig,
} from './contracts'

type BrowserLikeGlobal = typeof globalThis & {
  readonly document?: {
    readonly cookie?: string
  }
}

export function getSecurityClientConfig(): SecurityClientConfig {
  const runtime = globalThis as BrowserLikeGlobal
  const config = readSecurityClientConfigFromCookies(runtime.document?.cookie) ?? getDefaultSecurityClientConfig()
  return Object.freeze({ csrf: Object.freeze({ field: config.csrf.field, header: config.csrf.header, cookie: config.csrf.cookie }) })
}

export const securityClientInternals = {
  getDefaultSecurityClientConfig,
  readSecurityClientConfigFromCookies,
  ...securityClientConfigInternals,
}
