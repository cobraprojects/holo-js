import { requestUrlInternals } from '@holo-js/kernel'
import { getSecurityRuntimeBindings } from './runtime'
import { normalizeTrustedProxies, resolveForwarding } from './trusted-proxies'

export class SecurityClientAddressUnavailableError extends Error {
  constructor() {
    super('[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set TRUSTED_PROXIES=* or trustedProxies: \'*\' in config/security.ts when the app is reachable only through your proxy.')
    this.name = 'SecurityClientAddressUnavailableError'
  }
}

export function visitorAddress(request: Request): string | undefined {
  const trustedProxies = getSecurityRuntimeBindings()?.config.trustedProxies ?? normalizeTrustedProxies(undefined)
  return resolveForwarding(
    name => request.headers.get(name) ?? undefined,
    requestUrlInternals.currentConnectionAddress(),
    trustedProxies,
  ).address
}

export function ip(request: Request): string {
  const address = visitorAddress(request)
  if (!address) throw new SecurityClientAddressUnavailableError()
  return address
}
