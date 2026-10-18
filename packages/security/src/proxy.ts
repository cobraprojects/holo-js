import { HoloRequestUrlError, requestUrlInternals } from '@holo-js/kernel'
import { getSecurityRuntimeBindings } from './runtime'
import { normalizeTrustedProxies, resolveForwarding } from './trusted-proxies'

export class SecurityClientAddressUnavailableError extends Error {
  constructor() {
    super('[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set trustedProxies in config/security.ts so Holo can read it from your proxy.')
    this.name = 'SecurityClientAddressUnavailableError'
  }
}

export function ip(request: Request): string {
  const trustedProxies = getSecurityRuntimeBindings()?.config.trustedProxies ?? normalizeTrustedProxies(undefined)
  const { address, rejection } = resolveForwarding(
    name => request.headers.get(name) ?? undefined,
    requestUrlInternals.currentConnectionAddress(),
    trustedProxies,
  )
  if (rejection) throw new HoloRequestUrlError(rejection)
  if (!address) throw new SecurityClientAddressUnavailableError()
  return address
}
