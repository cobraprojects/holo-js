import { describe, expect, it } from 'vitest'
import {
  authConfigInternals,
  DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE,
  normalizeAuthConfig,
} from '../src/config'

const identityStore = {
  findByProviderUserId: async () => null,
  findByUserId: async () => null,
  save: async () => {},
}

function expectConfigError(config: unknown, message: string): void {
  expect(() => normalizeAuthConfig(config as never)).toThrow(message)
}

describe('auth config normalization', () => {
  it('normalizes every feature-owned auth configuration section', () => {
    const config = normalizeAuthConfig({
      defaults: { guard: 'admin', passwords: 'admins' },
      providers: {
        admins: { model: ' Admin ', identifiers: [' email ', 'email', 'username'] },
      },
      guards: {
        admin: { driver: 'session', provider: 'admins' },
        api: { driver: 'token', provider: 'admins' },
      },
      passwords: {
        admins: {
          provider: 'admins',
          table: ' admin_resets ',
          expire: '30',
          throttle: 10,
          route: ' /admin/reset ',
        },
      },
      emailVerification: { required: true, route: ' /confirm-email ' },
      multiFactor: {
        issuer: ' Holo Admin ',
        challengeRoute: ' /admin/mfa ',
        enrollmentTtl: '900',
        challengeTtl: 180,
        recoveryCodes: 10,
        allowedDriftSteps: 2,
      },
      personalAccessTokens: { defaultAbilities: ['read', 'write'] },
      socialEncryptionKey: ' social-key ',
      social: {
        github: {
          runtime: ' github-runtime ',
          clientId: ' client ',
          clientSecret: ' secret ',
          redirectUri: ' https://app.test/callback ',
          scopes: ['user:email'],
          guard: 'admin',
          mapToProvider: 'admins',
          encryptTokens: true,
        },
      },
      workos: {
        provider: 'dashboard',
        identityStore,
        dashboard: {
          clientId: ' client ',
          apiKey: ' key ',
          redirectUri: ' https://app.test/workos ',
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
      clerk: {
        provider: 'app',
        identityStore,
        app: {
          publishableKey: ' pk ',
          secretKey: ' sk ',
          apiUrl: ' https://api.test ',
          frontendApi: ' https://accounts.test ',
          redirectUri: ' https://app.test/clerk ',
          sessionCookie: ' clerk-cookie ',
          authorizedParties: [' https://app.test ', ''],
          guard: 'admin',
          mapToProvider: 'admins',
        },
      },
    })

    expect(config).toMatchObject({
      defaults: { guard: 'admin', passwords: 'admins' },
      providers: { admins: { model: 'Admin', identifiers: ['email', 'username'] } },
      passwords: {
        admins: { table: 'admin_resets', expire: 30, throttle: 10, route: '/admin/reset' },
      },
      emailVerification: { required: true, route: '/confirm-email' },
      multiFactor: {
        enabled: true,
        issuer: 'Holo Admin',
        challengeRoute: '/admin/mfa',
        enrollmentTtl: 900,
        challengeTtl: 180,
        recoveryCodes: 10,
        allowedDriftSteps: 2,
      },
      personalAccessTokens: { defaultAbilities: ['read', 'write'] },
      socialEncryptionKey: 'social-key',
      social: { github: { runtime: 'github-runtime', encryptTokens: true } },
      workos: { provider: 'dashboard', identityStore },
      clerk: { provider: 'app', identityStore },
    })
    const clerkApp = config.clerk.app
    expect(clerkApp && typeof clerkApp === 'object' && 'authorizedParties' in clerkApp
      ? clerkApp.authorizedParties
      : undefined).toEqual(['https://app.test'])

    expect(normalizeAuthConfig({ emailVerification: true }).emailVerification).toEqual({
      required: true,
      route: DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE,
    })
    expect(normalizeAuthConfig({ multiFactor: true }).multiFactor).toEqual({
      enabled: true,
      issuer: 'Holo',
      challengeRoute: '/mfa-challenge',
      enrollmentTtl: 600,
      challengeTtl: 300,
      recoveryCodes: 8,
      allowedDriftSteps: 1,
    })
    expect(normalizeAuthConfig({ multiFactor: false }).multiFactor.enabled).toBe(false)
    expect(normalizeAuthConfig({}, { appKey: ' app-key ' }).socialEncryptionKey).toBe('app-key')
    const defaultClerkApp = normalizeAuthConfig({ clerk: { app: {} } }).clerk.app
    expect(defaultClerkApp && typeof defaultClerkApp === 'object' && 'sessionCookie' in defaultClerkApp
      ? defaultClerkApp.sessionCookie
      : undefined).toBe('__session')
    expect(normalizeAuthConfig({
      workos: { provider: undefined, dashboard: {} },
      clerk: { provider: undefined, app: {} },
    })).toMatchObject({ workos: { dashboard: {} }, clerk: { app: {} } })
    expect(normalizeAuthConfig({
      workos: { provider: ' ', dashboard: {} },
      clerk: { provider: ' ', app: {} },
    })).toMatchObject({ workos: { dashboard: {} }, clerk: { app: {} } })
    expect(normalizeAuthConfig({ workos: { identityStore }, clerk: { identityStore } })).toMatchObject({
      workos: { identityStore },
      clerk: { identityStore },
    })
    expect(authConfigInternals.normalizeRegisteredAuthConfig({}, {
      get<TValue extends object>(): TValue | undefined {
        return { key: 'registry-key' } as unknown as TValue
      },
    }).socialEncryptionKey).toBe('registry-key')
  })

  it('rejects invalid providers, guards, password brokers, and defaults', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ providers: { ' ': { model: 'User' } } }, 'Auth provider name must be a non-empty string'],
      [{ providers: { users: { model: ' ' } } }, 'model must be a non-empty string'],
      [{ providers: { users: { model: 'User', identifiers: [] } } }, 'must declare at least one identifier'],
      [{ providers: { users: { model: 'User', identifiers: [' '] } } }, 'identifier entries must be non-empty'],
      [{ guards: { ' ': { driver: 'session' } } }, 'Auth guard name must be a non-empty string'],
      [{ guards: { web: { driver: 'session', provider: 'missing' } } }, 'references unknown provider'],
      [{ guards: { web: { driver: 'invalid' } } }, 'Unsupported auth guard driver'],
      [{ passwords: { ' ': { provider: 'users' } } }, 'Auth password broker name must be a non-empty string'],
      [{ passwords: { users: { provider: 'missing' } } }, 'references unknown provider'],
      [{ passwords: { users: { expire: 'invalid' } } }, 'expire must be an integer'],
      [{ passwords: { users: { expire: ' ' } } }, 'expire must be an integer'],
      [{ passwords: { users: { throttle: -1 } } }, 'must be greater than or equal to 0'],
      [{ defaults: { guard: 'missing' } }, 'default auth guard'],
      [{ defaults: { passwords: 'missing' } }, 'default password broker'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })

  it('rejects unsafe multi-factor configuration', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ multiFactor: null }, 'multi-factor configuration must be a boolean or object'],
      [{ multiFactor: [] }, 'multi-factor configuration must be a boolean or object'],
      [{ multiFactor: { issuer: `bad\nissuer` } }, 'issuer must be a bounded printable string'],
      [{ multiFactor: { challengeRoute: 'https://example.com/mfa' } }, 'challenge route must be a safe local path'],
      [{ multiFactor: { challengeRoute: '/../mfa' } }, 'challenge route must be a safe local path'],
      [{ multiFactor: { enrollmentTtl: 59 } }, 'enrollment TTL must be greater than or equal to 60'],
      [{ multiFactor: { challengeTtl: 29 } }, 'challenge TTL must be greater than or equal to 30'],
      [{ multiFactor: { recoveryCodes: 0 } }, 'recovery code count must be greater than or equal to 1'],
      [{ multiFactor: { allowedDriftSteps: -1 } }, 'allowed drift steps must be greater than or equal to 0'],
      [{ multiFactor: { recoveryCodes: 21 } }, 'configuration exceeds its security bounds'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })

  it('rejects invalid social provider references', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ social: { ' ': {} } }, 'Auth social provider name must be a non-empty string'],
      [{ social: { github: { guard: 'missing' } } }, 'references unknown guard'],
      [{ social: { github: { mapToProvider: 'missing' } } }, 'references unknown provider'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })

  it('rejects invalid WorkOS configuration boundaries', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ workos: { provider: 1 } }, 'provider key "provider" is reserved'],
      [{ workos: { identityStore: {} } }, 'identityStore must implement'],
      [{ workos: { dashboard: 'invalid' } }, 'must be an object'],
      [{ workos: { provider: 'missing' } }, 'is not configured'],
      [{ workos: { provider: 'missing', dashboard: {} } }, 'is not configured'],
      [{ workos: { ' ': {} } }, 'Auth WorkOS provider name must be a non-empty string'],
      [{ workos: { dashboard: { guard: 'missing' } } }, 'references unknown guard'],
      [{ workos: { dashboard: { mapToProvider: 'missing' } } }, 'references unknown provider'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })

  it('rejects invalid Clerk configuration boundaries', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ clerk: { provider: 1 } }, 'provider key "provider" is reserved'],
      [{ clerk: { identityStore: {} } }, 'identityStore must implement'],
      [{ clerk: { app: 'invalid' } }, 'must be a Clerk provider config object'],
      [{ clerk: { app: { authorizedParties: [1] } } }, 'must be a Clerk provider config object'],
      [{ clerk: { app: { secretKey: 1 } } }, 'must be a Clerk provider config object'],
      [{ clerk: { provider: 'missing' } }, 'is not configured'],
      [{ clerk: { provider: 'missing', app: {} } }, 'is not configured'],
      [{ clerk: { ' ': {} } }, 'Auth Clerk provider name must be a non-empty string'],
      [{ clerk: { app: { guard: 'missing' } } }, 'references unknown guard'],
      [{ clerk: { app: { mapToProvider: 'missing' } } }, 'references unknown provider'],
      [{ clerk: { app: { redirectUri: 'http://[' } } }, 'Invalid redirectUri'],
    ]
    for (const [config, message] of cases) expectConfigError(config, message)
  })
})
