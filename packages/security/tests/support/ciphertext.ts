export function flipCiphertextBit(value: string): string {
  const payload = Buffer.from(value, 'base64url')
  payload[payload.length - 1] = payload[payload.length - 1]! ^ 1
  return payload.toString('base64url')
}
