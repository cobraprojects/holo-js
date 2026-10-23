import { requestBodyInternals, requestUrlInternals } from '@holo-js/kernel'
import { normalizeCorsConfig, normalizeSecurityConfig } from './config'
import { createForwardedRequestResolver } from './trusted-proxies'
import type { SecurityRuntimeBindings, SecurityRuntimeFacade } from './contracts'

type RuntimeSecurityState = {
  bindings?: SecurityRuntimeFacade
}

function getSecurityRuntimeState(): RuntimeSecurityState {
  const runtime = globalThis as typeof globalThis & {
    __holoSecurityRuntime__?: RuntimeSecurityState
  }

  runtime.__holoSecurityRuntime__ ??= {}
  return runtime.__holoSecurityRuntime__
}

export class SecurityRuntimeNotConfiguredError extends Error {
  constructor() {
    super('[@holo-js/security] Security runtime is not configured yet.')
  }
}

export function configureSecurityRuntime(bindings?: SecurityRuntimeBindings): void {
  const config = bindings ? normalizeSecurityConfig(bindings.config) : undefined
  requestUrlInternals.configureForwardedRequestResolver(config ? createForwardedRequestResolver(config.trustedProxies) : undefined)
  requestBodyInternals.configureMaxRequestBodyBytes(config?.maxBodyBytes)
  requestBodyInternals.configureMaxUploadBodyBytes(config?.maxUploadBodyBytes)
  getSecurityRuntimeState().bindings = bindings && config
    ? Object.freeze({
        config,
        cors: normalizeCorsConfig(bindings.cors),
        rateLimitStore: bindings.rateLimitStore,
        csrfSigningKey: bindings.csrfSigningKey,
        csrfSession: bindings.csrfSession,
        defaultKeyResolver: bindings.defaultKeyResolver,
      })
    : undefined
}

export function getSecurityRuntime(): SecurityRuntimeFacade {
  const bindings = getSecurityRuntimeState().bindings
  if (!bindings) {
    throw new SecurityRuntimeNotConfiguredError()
  }

  return bindings
}

export function getSecurityRuntimeBindings(): SecurityRuntimeFacade | undefined {
  return getSecurityRuntimeState().bindings
}

export function resetSecurityRuntime(): void {
  requestUrlInternals.configureForwardedRequestResolver(undefined)
  requestBodyInternals.configureMaxRequestBodyBytes(undefined)
  requestBodyInternals.configureMaxUploadBodyBytes(undefined)
  getSecurityRuntimeState().bindings = undefined
}

export const securityRuntimeInternals = {
  getSecurityRuntimeState,
}
