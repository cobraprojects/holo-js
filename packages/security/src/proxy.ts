import { requestUrlInternals } from '@holo-js/kernel'
import { getSecurityRuntimeBindings } from './runtime'
import { normalizeTrustedProxies, resolveForwarding } from './trusted-proxies'

export class SecurityClientAddressUnavailableError extends Error {
  constructor() {
    super('[@holo-js/security] The client address is unavailable because this framework does not expose the connection address. Set trustedProxies in config/security.ts (scaffolded apps read it from TRUSTED_PROXIES). In Next.js, set it to \'*\' only when the app is reachable exclusively through a proxy that overwrites X-Forwarded-For, such as Vercel\'s edge, or a reverse proxy with the Next.js server bound to localhost or a private network. In Nuxt and SvelteKit, list your proxy\'s addresses or CIDR ranges. See https://docs.holo-js.com/basics/security/cors-and-proxies#trusted-proxies')
    this.name = 'SecurityClientAddressUnavailableError'
  }
}

export function ip(request: Request): string {
  const trustedProxies = getSecurityRuntimeBindings()?.config.trustedProxies ?? normalizeTrustedProxies(undefined)
  const { address } = resolveForwarding(
    name => request.headers.get(name) ?? undefined,
    requestUrlInternals.currentConnectionAddress(),
    trustedProxies,
  )
  if (!address) throw new SecurityClientAddressUnavailableError()
  return address
}
