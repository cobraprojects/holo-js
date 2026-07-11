export function shouldTrustProxyHeaders(): boolean {
  const trustedProxy = typeof process !== 'undefined'
    ? process.env.HOLO_SECURITY_TRUST_PROXY?.trim().toLowerCase()
    : undefined

  return trustedProxy === '1'
    || trustedProxy === 'true'
    || trustedProxy === 'yes'
    || trustedProxy === 'on'
}
