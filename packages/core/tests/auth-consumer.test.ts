import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { it } from 'vitest'

const execFileAsync = promisify(execFile)

it('preserves concrete app auth users across ORM and hosted provider integrations', async () => {
  const root = await mkdtemp(join(import.meta.dirname, '../.tmp-auth-consumer-'))
  try {
    await writeFile(join(root, 'app.ts'), `
import { expectTypeOf } from 'vitest'
import auth, { type AuthenticatedAuthUser, type AuthUser } from '@holo-js/auth'
import { type HoloRuntime } from '../src'
import { syncIdentity as syncClerkIdentity } from '@holo-js/auth-clerk'
import { syncIdentity as syncWorkosIdentity } from '@holo-js/auth-workos'
import { callback as authenticateSocial } from '@holo-js/auth-social'

type AppUser = {
  readonly id: number
  readonly email: string
  readonly name: string
  readonly role: 'admin' | 'member'
  readonly created_at: string
}

declare module '@holo-js/auth' {
  interface HoloAuthTypeRegistry {
    user: AppUser
  }
}

expectTypeOf<AuthUser>().toEqualTypeOf<AppUser>()
expectTypeOf(auth.user).returns.toEqualTypeOf<Promise<AuthenticatedAuthUser | null>>()
expectTypeOf<Awaited<ReturnType<NonNullable<HoloRuntime['auth']>['user']>>>().toEqualTypeOf<AuthenticatedAuthUser | null>()
void [syncClerkIdentity, syncWorkosIdentity, authenticateSocial]
`, 'utf8')
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
      extends: '../tsconfig.json',
      compilerOptions: { lib: ['ES2022', 'DOM', 'DOM.Iterable'] },
      include: ['./app.ts'],
    }))
    try {
      await execFileAsync('bun', ['x', 'tsc', '-p', join(root, 'tsconfig.json'), '--noEmit'], {
        cwd: join(import.meta.dirname, '..'),
      })
    } catch (error) {
      const failure = error as Error & { readonly stdout?: string, readonly stderr?: string }
      throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
