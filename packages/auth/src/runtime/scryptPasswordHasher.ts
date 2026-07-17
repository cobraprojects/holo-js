import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import type { AuthPasswordHasher } from '../contracts'

const SCRYPT_PREFIX = 'scrypt'
const SCRYPT_TARGET_N = 16_384
const SCRYPT_TARGET_R = 8
const SCRYPT_TARGET_P = 1
const SCRYPT_KEY_LENGTH = 64
const SCRYPT_KEY_HEX_LENGTH = SCRYPT_KEY_LENGTH * 2
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/i
type ScryptParams = { readonly N: number, readonly r: number, readonly p: number }
type ScryptFunction = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void
const SCRYPT_TARGET_PARAMS: ScryptParams = { N: SCRYPT_TARGET_N, r: SCRYPT_TARGET_R, p: SCRYPT_TARGET_P }
const defaultScrypt = nodeScrypt as ScryptFunction
let scrypt = defaultScrypt

function encodeScryptParams(params: ScryptParams): string {
  return `N=${params.N},r=${params.r},p=${params.p}`
}

function parseScryptParams(value: string): ScryptParams | null {
  const params: Partial<Record<keyof ScryptParams, number>> = {}
  for (const entry of value.split(',')) {
    const [rawKey, rawValue] = entry.split('=', 2)
    const key = rawKey?.trim()
    const normalizedValue = rawValue?.trim()
    if ((key === 'N' || key === 'r' || key === 'p') && normalizedValue) {
      if (!/^\d+$/.test(normalizedValue)) {
        return null
      }

      params[key] = Number.parseInt(normalizedValue, 10)
    }
  }
  const { N, r, p } = params
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') {
    return null
  }
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return null
  }
  if (N <= 0 || r <= 0 || p <= 0) {
    return null
  }
  return { N, r, p }
}

function isHex(value: string): boolean {
  return HEX_PATTERN.test(value)
}

function isInvalidScryptParamsError(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { readonly code?: unknown }).code === 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS'
}

function parseScryptDigest(digest: string): {
  readonly params: ScryptParams
  readonly legacy: boolean
  readonly saltHex: string
  readonly hashHex: string
} | null {
  const [prefix, paramsOrSaltHex, saltOrHashHex, maybeHashHex] = digest.split('$')
  if (prefix !== SCRYPT_PREFIX || !paramsOrSaltHex || !saltOrHashHex) {
    return null
  }
  if (!maybeHashHex) {
    if (!isHex(paramsOrSaltHex) || !isHex(saltOrHashHex) || saltOrHashHex.length !== SCRYPT_KEY_HEX_LENGTH) {
      return null
    }

    return { params: SCRYPT_TARGET_PARAMS, legacy: true, saltHex: paramsOrSaltHex, hashHex: saltOrHashHex }
  }
  if (!isHex(saltOrHashHex) || !isHex(maybeHashHex) || maybeHashHex.length !== SCRYPT_KEY_HEX_LENGTH) {
    return null
  }

  const params = parseScryptParams(paramsOrSaltHex)
  return params ? { params, legacy: false, saltHex: saltOrHashHex, hashHex: maybeHashHex } : null
}

async function deriveScryptKey(password: string, salt: Buffer, keyLength: number, params: ScryptParams): Promise<Buffer> {
  const options = { cost: params.N, blockSize: params.r, parallelization: params.p } satisfies ScryptOptions

  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }

      resolve(derivedKey)
    })
  })
}

export function createScryptPasswordHasher(): AuthPasswordHasher {
  return {
    async hash(password) {
      const salt = randomBytes(16)
      const derived = await deriveScryptKey(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_TARGET_PARAMS)
      return `${SCRYPT_PREFIX}$${encodeScryptParams(SCRYPT_TARGET_PARAMS)}$${salt.toString('hex')}$${derived.toString('hex')}`
    },
    async verify(password, digest) {
      const parsed = parseScryptDigest(digest)
      if (!parsed) {
        return false
      }
      const salt = Buffer.from(parsed.saltHex, 'hex')
      const expected = Buffer.from(parsed.hashHex, 'hex')
      const derived = await deriveScryptKey(password, salt, expected.length, parsed.params).catch((error: unknown) => {
        if (isInvalidScryptParamsError(error)) {
          return null
        }

        throw error
      })
      if (!derived) {
        return false
      }

      return derived.length === expected.length && timingSafeEqual(derived, expected)
    },
    needsRehash(digest) {
      const parsed = parseScryptDigest(digest)
      return !parsed
        || parsed.legacy
        || parsed.params.N < SCRYPT_TARGET_N
        || parsed.params.r < SCRYPT_TARGET_R
        || parsed.params.p < SCRYPT_TARGET_P
    },
  }
}

export const scryptPasswordHasherInternals = {
  resetScrypt(): void {
    scrypt = defaultScrypt
  },
  setScrypt(value: ScryptFunction): void {
    scrypt = value
  },
}
