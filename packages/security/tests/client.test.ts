import { afterEach, describe, expect, it } from 'vitest'
import { getSecurityClientConfig, securityClientInternals } from '../src/client'
import { SECURITY_CLIENT_CONFIG_COOKIE, serializeSecurityClientConfig } from '../src/client-config'

const browserGlobal = globalThis as typeof globalThis & {
  document?: {
    cookie?: string
  }
}
const originalDocument = browserGlobal.document

afterEach(() => {
  if (typeof originalDocument === 'undefined') {
    delete browserGlobal.document
  } else {
    browserGlobal.document = originalDocument
  }
})

describe('@holo-js/security client config', () => {
  it('returns default browser csrf settings when the middleware config cookie is missing', () => {
    const config = getSecurityClientConfig()

    expect(config).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.csrf)).toBe(true)
  })

  it('reads csrf settings from the middleware-issued config cookie', () => {
    browserGlobal.document = {
      cookie: `${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(serializeSecurityClientConfig({
        csrf: {
          field: '_csrf',
          cookie: 'csrf-token',
        },
      }))}`,
    }

    expect(getSecurityClientConfig()).toEqual({
      csrf: {
        field: '_csrf',
        cookie: 'csrf-token',
      },
    })
  })

  it('falls back to defaults when the middleware config cookie is malformed', () => {
    browserGlobal.document = {
      cookie: `${SECURITY_CLIENT_CONFIG_COOKIE}=not-json`,
    }

    expect(getSecurityClientConfig()).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })
  })

  it('ignores malformed cookie segments and invalid config payloads', () => {
    expect(securityClientInternals.parseCookieHeader('broken; %=bad; =missing-name; ok=value')).toEqual({
      ok: 'value',
    })
    expect(securityClientInternals.readSecurityClientConfigFromCookies(`${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(JSON.stringify({
      csrf: {
        field: '_csrf',
      },
    }))}`)).toBeUndefined()
  })

  it('exposes the browser client runtime internals for tests', () => {
    expect(securityClientInternals.getDefaultSecurityClientConfig()).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })
    expect(securityClientInternals.readSecurityClientConfigFromCookies(`${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(JSON.stringify({
      csrf: {
        field: '_csrf',
        cookie: 'csrf-token',
      },
    }))}`)).toEqual({
      csrf: {
        field: '_csrf',
        cookie: 'csrf-token',
      },
    })
  })
})
