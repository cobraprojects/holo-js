import type { SecurityClientBindings, SecurityClientConfig } from './contracts'

export type {
  SecurityClientBindings,
  SecurityClientConfig,
} from './contracts'

type RuntimeSecurityClientState = {
  bindings?: SecurityClientConfig
}

const DEFAULT_SECURITY_CLIENT_CONFIG: SecurityClientConfig = Object.freeze({
  csrf: Object.freeze({
    field: '_token',
    cookie: 'XSRF-TOKEN',
  }),
})

function getDefaultSecurityClientConfig(): SecurityClientConfig {
  return DEFAULT_SECURITY_CLIENT_CONFIG
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
  const csrf = Object.freeze({
    field: bindings?.config?.csrf?.field ?? defaults.csrf.field,
    cookie: bindings?.config?.csrf?.cookie ?? defaults.csrf.cookie,
  })

  return Object.freeze({
    csrf,
  })
}

export function configureSecurityClient(bindings?: SecurityClientBindings): void {
  getSecurityClientState().bindings = bindings
    ? normalizeSecurityClientConfig(bindings)
    : undefined
}

export function getSecurityClientConfig(): SecurityClientConfig {
  return getSecurityClientState().bindings ?? DEFAULT_SECURITY_CLIENT_CONFIG
}

export function resetSecurityClient(): void {
  getSecurityClientState().bindings = undefined
}

export const securityClientInternals = {
  getDefaultSecurityClientConfig,
  getSecurityClientState,
  normalizeSecurityClientConfig,
}
