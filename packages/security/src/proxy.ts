import { isIP } from 'node:net'
import { requestUrlInternals } from '@holo-js/kernel'
import { ip } from './contracts'

function bareClientAddress(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (isIP(value)) return value
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(value)?.[1]
  if (bracketed && isIP(bracketed) === 6) return bracketed
  const ipv4 = /^([\d.]+):\d+$/u.exec(value)?.[1]
  return ipv4 && isIP(ipv4) === 4 ? ipv4 : undefined
}

export function resolveTrustedClientIp(request: Request): string {
  const trustedProxyHeaders = requestUrlInternals.resolveTrustedProxyHeaders()
  if (trustedProxyHeaders === 'forwarded') {
    return bareClientAddress(requestUrlInternals.readForwardedParameter(request.headers, 'for')) ?? 'unknown'
  }

  return ip(request, trustedProxyHeaders === 'x-forwarded')
}
