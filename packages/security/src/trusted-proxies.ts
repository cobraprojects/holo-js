import { BlockList, isIP } from 'node:net'
import type { HoloForwardedRequest, HoloForwardedRequestResolver } from '@holo-js/kernel'

export type SecurityTrustedProxies = readonly string[] | '*'

type HeaderReader = (name: string) => string | undefined

const ipv4MappedPrefix = '::ffff:'

function canonicalAddress(address: string): string {
  const lowered = address.toLowerCase()
  if (lowered.startsWith(ipv4MappedPrefix) && isIP(lowered.slice(ipv4MappedPrefix.length)) === 4) {
    return lowered.slice(ipv4MappedPrefix.length)
  }
  return address
}

function bareAddress(value: string): string | undefined {
  const trimmed = value.trim()
  if (isIP(trimmed)) return canonicalAddress(trimmed)
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(trimmed)?.[1]
  if (bracketed && isIP(bracketed) === 6) return canonicalAddress(bracketed)
  const ipv4 = /^([\d.]+):\d+$/u.exec(trimmed)?.[1]
  return ipv4 && isIP(ipv4) === 4 ? ipv4 : undefined
}

function parseRange(entry: string): { readonly address: string, readonly prefix?: number } | undefined {
  const [address = '', prefix, ...rest] = entry.trim().split('/')
  const family = isIP(address)
  if (!family || rest.length > 0) return undefined
  if (prefix === undefined) return { address }
  if (!/^\d+$/u.test(prefix)) return undefined
  const bits = Number(prefix)
  return bits <= (family === 4 ? 32 : 128) ? { address, prefix: bits } : undefined
}

export function normalizeTrustedProxies(value: SecurityTrustedProxies | undefined): SecurityTrustedProxies {
  if (value === undefined) return Object.freeze([])
  if (value === '*') return value
  return Object.freeze(value.map((entry) => {
    if (!parseRange(entry)) {
      throw new TypeError(`[@holo-js/security] trustedProxies entries must be IP addresses or CIDR ranges, received "${entry}".`)
    }
    return entry.trim()
  }))
}

function createTrustedAddressMatcher(trustedProxies: SecurityTrustedProxies, connectionAddress: string | undefined): (address: string) => boolean {
  if (trustedProxies === '*') return address => address === connectionAddress
  const ranges = new BlockList()
  for (const entry of trustedProxies) {
    const range = parseRange(entry)
    if (!range) continue
    const family = isIP(range.address) === 4 ? 'ipv4' : 'ipv6'
    if (range.prefix === undefined) ranges.addAddress(range.address, family)
    else ranges.addSubnet(range.address, range.prefix, family)
  }
  return address => ranges.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
}

const secureProtocols = new Set(['https', 'on', 'ssl', '1'])

function firstListValue(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined
}

function forwardedProtocol(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return secureProtocols.has(value.toLowerCase()) ? 'https' : 'http'
}

function clientAddress(
  forwardedFor: string | undefined,
  connectionAddress: string | undefined,
  isTrusted: (address: string) => boolean,
): string | undefined {
  let client: string | undefined
  let firstTrusted: string | undefined
  for (const entry of [...forwardedFor?.split(',') ?? [], ...connectionAddress === undefined ? [] : [connectionAddress]]) {
    const address = bareAddress(entry)
    if (!address) continue
    if (isTrusted(address)) firstTrusted ??= address
    else client = address
  }
  return client ?? firstTrusted
}

export function resolveForwarding(
  readHeader: HeaderReader,
  rawConnectionAddress: string | undefined,
  trustedProxies: SecurityTrustedProxies,
): HoloForwardedRequest {
  const connectionAddress = rawConnectionAddress === undefined ? undefined : bareAddress(rawConnectionAddress) ?? rawConnectionAddress
  const isTrusted = createTrustedAddressMatcher(trustedProxies, connectionAddress)
  const fromTrustedProxy = connectionAddress === undefined ? trustedProxies === '*' : isTrusted(connectionAddress)
  if (!fromTrustedProxy) return { address: connectionAddress }
  return {
    address: clientAddress(readHeader('x-forwarded-for'), connectionAddress, isTrusted),
    protocol: forwardedProtocol(firstListValue(readHeader('x-forwarded-proto'))),
    host: firstListValue(readHeader('x-forwarded-host')),
    port: firstListValue(readHeader('x-forwarded-port')),
    prefix: firstListValue(readHeader('x-forwarded-prefix')),
  }
}

export function createForwardedRequestResolver(trustedProxies: SecurityTrustedProxies): HoloForwardedRequestResolver {
  return (readHeader, connectionAddress) => resolveForwarding(readHeader, connectionAddress, trustedProxies)
}
