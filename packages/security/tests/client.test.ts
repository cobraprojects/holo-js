import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityClient, getSecurityClientConfig, resetSecurityClient, securityClientInternals } from '../src/client'

afterEach(() => {
  resetSecurityClient()
})

describe('@holo-js/security client config', () => {
  it('returns default browser csrf settings when no client override is configured', () => {
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

  it('normalizes and resets browser client config overrides', () => {
    configureSecurityClient({
      config: {
        csrf: {
          field: '_csrf',
        },
      },
    })

    expect(getSecurityClientConfig()).toEqual({
      csrf: {
        field: '_csrf',
        cookie: 'XSRF-TOKEN',
      },
    })

    resetSecurityClient()

    expect(getSecurityClientConfig()).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })

    configureSecurityClient()
    expect(getSecurityClientConfig()).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })
  })

  it('exposes the browser client runtime internals for tests', () => {
    expect(securityClientInternals.getDefaultSecurityClientConfig()).toEqual({
      csrf: {
        field: '_token',
        cookie: 'XSRF-TOKEN',
      },
    })
    expect(securityClientInternals.normalizeSecurityClientConfig({
      config: {
        csrf: {
          cookie: 'csrf-token',
        },
      },
    })).toEqual({
      csrf: {
        field: '_token',
        cookie: 'csrf-token',
      },
    })
  })
})
