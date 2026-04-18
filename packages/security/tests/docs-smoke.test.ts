import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readDoc(pathname: string): Promise<string> {
  return readFile(resolve(root, pathname), 'utf8')
}

describe('security documentation smoke checks', () => {
  it('covers install flow, config, csrf helpers, and protected routes', async () => {
    const security = await readDoc('apps/docs/docs/security.md')
    const installation = await readDoc('apps/docs/docs/installation.md')

    expect(security).toContain('bunx holo install security')
    expect(security).toContain('config/security.ts')
    expect(security).toContain('defineSecurityConfig')
    expect(security).toContain('limit.perMinute(5)')
    expect(security).toContain('defaultRateLimitKey')
    expect(security).toContain('createHmac')
    expect(security).toContain('APP_KEY')
    expect(security).not.toContain('createStableEmailHash(')
    expect(security).toContain('csrf.field(request)')
    expect(security).toContain('csrf.cookie(request)')
    expect(security).toContain('protect(request, {')
    expect(security).toContain("throttle: 'api'")
    expect(security).toContain('419')
    expect(security).toContain('429')
    expect(installation).toContain('security')
    expect(installation).toContain('--package forms,validation,security')
  })

  it('covers final forms integration examples and driver semantics', async () => {
    const security = await readDoc('apps/docs/docs/security.md')
    const serverValidation = await readDoc('apps/docs/docs/forms/server-validation.md')
    const clientUsage = await readDoc('apps/docs/docs/forms/client-usage.md')
    const frameworkIntegration = await readDoc('apps/docs/docs/forms/framework-integration.md')

    expect(security).toContain("throttle: 'login'")
    expect(security).toContain("throttle: 'register'")
    expect(security).toContain("rateLimit('send-invite'")
    expect(security).toContain('holo rate-limit:clear')
    expect(security).toContain('user:<id>')
    expect(security).toContain('ip:<client-ip>')
    expect(security).toContain('| `memory` | No | No |')
    expect(security).toContain('| `file` | Yes, on the same machine | No |')
    expect(security).toContain('| `redis` | Yes | Yes |')
    expect(security).toContain("configureSecurityClient")
    expect(security).toContain('server-only')
    expect(security).toContain('fully typed')

    expect(serverValidation).toContain("throttle: 'login'")
    expect(serverValidation).toContain("throttle: 'register'")
    expect(serverValidation).toContain('csrf: true')
    expect(clientUsage).toContain('csrf: true')
    expect(clientUsage).toContain('not a client option')
    expect(clientUsage).toContain("configureSecurityClient")
    expect(frameworkIntegration).toContain("throttle: 'login'")
    expect(frameworkIntegration).toContain('csrf: true')
    expect(frameworkIntegration).toContain('does not expose `throttle`')
  })
})
