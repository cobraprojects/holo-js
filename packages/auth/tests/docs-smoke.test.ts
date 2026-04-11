import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

async function readDoc(name: string): Promise<string> {
  return readFile(resolve(root, 'apps/docs/docs/auth', name), 'utf8')
}

describe('auth documentation smoke checks', () => {
  it('covers the package split and route ownership story', async () => {
    const overview = await readDoc('index.md')
    expect(overview).toContain('@holo-js/session')
    expect(overview).toContain('@holo-js/auth')
    expect(overview).toContain('@holo-js/auth-social')
    expect(overview).toContain('@holo-js/auth-workos')
    expect(overview).toContain('@holo-js/auth-clerk')
    expect(overview).toContain('owns the route')
    expect(overview).toContain('`@holo-js/auth` is the server package')
    expect(overview).toContain('`@holo-js/auth/client` is the browser-friendly package')
  })

  it('covers session config and cookie helpers', async () => {
    const session = await readDoc('session-and-cookies.md')
    expect(session).toContain('defineSessionConfig')
    expect(session).toContain('createSession')
    expect(session).toContain('sessionCookie')
    expect(session).toContain('httpOnly')
    expect(session).toContain('sameSite')
  })

  it('covers local auth, guards, and token APIs', async () => {
    const local = await readDoc('local-auth.md')
    const guards = await readDoc('guards-and-providers.md')
    const tokens = await readDoc('personal-access-tokens.md')

    expect(local).toContain('auth.guard(\'admin\')')
    expect(local).toContain('login')
    expect(local).toContain('loginUsing')
    expect(local).toContain('loginUsingId')
    expect(local).toContain('hashPassword')
    expect(local).toContain('verifyPassword')
    expect(local).toContain('impersonate')
    expect(local).toContain('stopImpersonating')
    expect(local).toContain('logout')
    expect(local).toContain('register')
    expect(local).toContain('phone')
    expect(local).toContain('identifiers')
    expect(guards).toContain('web')
    expect(guards).toContain('admin')
    expect(guards).toContain('identifiers')
    expect(tokens).toContain('tokens.create')
    expect(tokens).toContain('tokens.authenticate')
    expect(tokens).toContain('tokens.can')
  })

  it('covers social, WorkOS, and Clerk integrations', async () => {
    const social = await readDoc('social-login.md')
    const workos = await readDoc('workos.md')
    const clerk = await readDoc('clerk.md')

    expect(social).toContain('@holo-js/auth-social')
    expect(social).toContain('redirect')
    expect(social).toContain('callback')
    expect(workos).toContain('@holo-js/auth-workos')
    expect(workos).toContain('verifyRequest')
    expect(workos).toContain('authenticate')
    expect(clerk).toContain('@holo-js/auth-clerk')
    expect(clerk).toContain('verifyRequest')
    expect(clerk).toContain('authenticate')
  })

  it('covers current-user client helpers and lifecycle-token delivery limitations', async () => {
    const client = await readDoc('current-auth-client.md')
    const verification = await readDoc('email-verification.md')
    const reset = await readDoc('password-reset.md')

    expect(client).toContain('@holo-js/auth/client')
    expect(client).toContain('refreshUser')
    expect(client).toContain('/api/auth/user')
    expect(client).toContain('check()')
    expect(client).toContain('does not expose')
    expect(client).toContain('hashPassword()')
    expect(client).toContain('impersonate()')
    expect(verification).toContain('verification.create')
    expect(verification).toContain('verification.consume')
    expect(verification).toContain('temporary')
    expect(reset).toContain('passwords.request')
    expect(reset).toContain('passwords.consume')
  })
})
