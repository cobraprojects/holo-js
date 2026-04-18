import { normalizeSecurityConfig } from '@holo-js/config'
import type { SecurityClientBindings, SecurityClientConfig } from './contracts'

export type {
  SecurityClientBindings,
  SecurityClientConfig,
} from './contracts'

type RuntimeSecurityClientState = {
  bindings?: SecurityClientConfig
}

function getDefaultSecurityClientConfig(): SecurityClientConfig {
  const config = normalizeSecurityConfig({})

  return Object.freeze({
    csrf: {
      field: config.csrf.field,
      cookie: config.csrf.cookie,
    },
  })
}

function getSecurityClientState(): RuntimeSecurityClientState {
  const runtime = globalThis as typeof globalThis & {
    __holoSecurityClient__?: RuntimeSecurityClientState
  }

  runtime.__holoSecurityClient__ ??= {}
  return runtime.__holoSecurityClient__
}

function normalizeSecurityClientConfig(bindings?: SecurityClientBindings): SecurityClientConfig {
  const defaults = getDefaultSecurityClientConfig()

  return Object.freeze({
    csrf: {
      field: bindings?.config?.csrf?.field ?? defaults.csrf.field,
      cookie: bindings?.config?.csrf?.cookie ?? defaults.csrf.cookie,
    },
  })
}

export function configureSecurityClient(bindings?: SecurityClientBindings): void {
  getSecurityClientState().bindings = bindings
    ? normalizeSecurityClientConfig(bindings)
    : undefined
}

export function getSecurityClientConfig(): SecurityClientConfig {
  return getSecurityClientState().bindings ?? getDefaultSecurityClientConfig()
}

export function resetSecurityClient(): void {
  getSecurityClientState().bindings = undefined
}

export const securityClientInternals = {
  getDefaultSecurityClientConfig,
  getSecurityClientState,
  normalizeSecurityClientConfig,
}
