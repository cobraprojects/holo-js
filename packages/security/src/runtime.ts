import { normalizeSecurityConfig } from '@holo-js/config'
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
  getSecurityRuntimeState().bindings = bindings
    ? Object.freeze({
        config: normalizeSecurityConfig(bindings.config),
        rateLimitStore: bindings.rateLimitStore,
        csrfSigningKey: bindings.csrfSigningKey,
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
  getSecurityRuntimeState().bindings = undefined
}

export const securityRuntimeInternals = {
  getSecurityRuntimeState,
}
