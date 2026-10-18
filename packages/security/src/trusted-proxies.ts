import { BlockList, isIP } from 'node:net'
import type { HoloForwardedRequestResolver } from '@holo-js/kernel'

export type SecurityTrustedProxies = readonly string[] | '*'

export type ResolvedForwarding = {
  readonly address?: string
  readonly protocol?: string
  readonly host?: string
  readonly rejection?: string
}

type HeaderReader = (name: string) => string | undefined

type ForwardedHop = {
  readonly chain: readonly string[]
  readonly protocol?: string
  readonly host?: string
}

const ipv4MappedPrefix = '::ffff:'

function canonicalAddress(address: string): string {
  const lowered = address.toLowerCase()
  if (lowered.startsWith(ipv4MappedPrefix) && isIP(lowered.slice(ipv4MappedPrefix.length)) === 4) {
    return lowered.slice(ipv4MappedPrefix.length)
  }
  return address
}

function bareAddress(value: string): string | undefined {
  const unquoted = value.trim().replace(/^"|"$/gu, '')
  if (isIP(unquoted)) return canonicalAddress(unquoted)
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/u.exec(unquoted)?.[1]
  if (bracketed && isIP(bracketed) === 6) return canonicalAddress(bracketed)
  const ipv4 = /^([\d.]+):\d+$/u.exec(unquoted)?.[1]
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

function createTrustedAddressMatcher(trustedProxies: SecurityTrustedProxies): (address: string) => boolean {
  if (trustedProxies === '*') return () => false
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

function lastListValue(value: string | undefined): string | undefined {
  return value?.split(',').map(entry => entry.trim()).filter(Boolean).at(-1)
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let escaped = false
  for (const character of value) {
    if (escaped) {
      escaped = false
    } else if (character === '\\' && quoted) {
      escaped = true
    } else if (character === '"') {
      quoted = !quoted
    } else if (character === separator && !quoted) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts
}

function unquote(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\(.)/gu, '$1')
    : trimmed
}

function parseForwardedElement(element: string): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>()
  for (const pair of splitOutsideQuotes(element, ';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const name = pair.slice(0, separator).trim().toLowerCase()
    if (name && !pairs.has(name)) pairs.set(name, unquote(pair.slice(separator + 1)))
  }
  return pairs
}

function readXForwardedHop(readHeader: HeaderReader): ForwardedHop | undefined {
  const forwardedFor = readHeader('x-forwarded-for')
  const protocol = lastListValue(readHeader('x-forwarded-proto'))
  const host = lastListValue(readHeader('x-forwarded-host'))
  if (forwardedFor === undefined && protocol === undefined && host === undefined) return undefined
  return {
    chain: forwardedFor?.split(',').map(entry => entry.trim()).filter(Boolean) ?? [],
    protocol,
    host,
  }
}

function readForwardedHop(readHeader: HeaderReader): ForwardedHop | undefined {
  const forwarded = readHeader('forwarded')
  if (forwarded === undefined) return undefined
  const elements = splitOutsideQuotes(forwarded, ',').map(parseForwardedElement)
  const nearest = elements.at(-1)
  return {
    chain: elements.flatMap(element => element.get('for') ?? []),
    protocol: nearest?.get('proto'),
    host: nearest?.get('host'),
  }
}

function clientFromChain(chain: readonly string[], isTrusted: (address: string) => boolean): string | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const entry = chain[index] ?? ''
    const address = bareAddress(entry)
    if (address && isTrusted(address)) continue
    return address ?? entry
  }
  const first = chain[0]
  return first === undefined ? undefined : bareAddress(first) ?? first
}

function resolveHop(hop: ForwardedHop, connectionAddress: string | undefined, isTrusted: (address: string) => boolean): ResolvedForwarding {
  return {
    address: clientFromChain(hop.chain, isTrusted) ?? connectionAddress,
    protocol: hop.protocol,
    host: hop.host,
  }
}

function agrees(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left.toLowerCase() === right.toLowerCase()
}

export function resolveForwarding(
  readHeader: HeaderReader,
  rawConnectionAddress: string | undefined,
  trustedProxies: SecurityTrustedProxies,
): ResolvedForwarding {
  const connectionAddress = rawConnectionAddress === undefined ? undefined : bareAddress(rawConnectionAddress) ?? rawConnectionAddress
  if (trustedProxies !== '*' && trustedProxies.length === 0) return { address: connectionAddress }
  const isTrusted = createTrustedAddressMatcher(trustedProxies)
  const peerIsTrusted = connectionAddress === undefined || trustedProxies === '*' || isTrusted(connectionAddress)
  if (!peerIsTrusted) return { address: connectionAddress }

  const xForwarded = readXForwardedHop(readHeader)
  const forwarded = readForwardedHop(readHeader)
  const fromXForwarded = xForwarded && resolveHop(xForwarded, connectionAddress, isTrusted)
  const fromForwarded = forwarded && resolveHop(forwarded, connectionAddress, isTrusted)
  if (fromXForwarded && fromForwarded && !(
    agrees(fromXForwarded.address, fromForwarded.address)
    && agrees(fromXForwarded.protocol, fromForwarded.protocol)
    && agrees(fromXForwarded.host, fromForwarded.host)
  )) {
    return { rejection: 'Forwarded and X-Forwarded headers must describe the same client.' }
  }
  return fromForwarded ?? fromXForwarded ?? { address: connectionAddress }
}

export function createForwardedRequestResolver(trustedProxies: SecurityTrustedProxies): HoloForwardedRequestResolver {
  return (readHeader, connectionAddress) => {
    const { protocol, host, rejection } = resolveForwarding(readHeader, connectionAddress, trustedProxies)
    return { protocol, host, rejection }
  }
}
