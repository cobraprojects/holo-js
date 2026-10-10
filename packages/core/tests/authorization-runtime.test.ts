import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { configureQueueRuntime, getQueueRuntime } from '@holo-js/queue'
import * as authorizationModule from '@holo-js/authorization'
import { authorizationInternals, defineAbility, definePolicy } from '@holo-js/authorization'
import type { GeneratedProjectRegistry } from '../src/portable/registry'
import { reconfigureOptionalHoloSubsystems, resetOptionalHoloSubsystems, holoRuntimeInternals, createHolo } from '../src'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-authorization-runtime-'))
  tempDirs.push(root)

  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/models'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'core-authorization-runtime-fixture',
    private: true,
    type: 'module',
  }, null, 2))
  await writeFile(join(root, 'config/app.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/database.ts'), 'export default {}', 'utf8')
  await writeFile(join(root, 'config/auth.ts'), `
import { defineAuthConfig } from '@holo-js/auth'

export default defineAuthConfig({
  defaults: {
    guard: 'web',
  },
  guards: {
    web: {
      driver: 'session',
      provider: 'users',
    },
  },
  })
`, 'utf8')
  await writeFile(join(root, 'config/session.ts'), `
import { defineSessionConfig } from '@holo-js/session'

export default defineSessionConfig({})
`, 'utf8')
  await writeFile(join(root, 'server/models/User.ts'), 'export default {}', 'utf8')

  await Promise.all([
    symlink(join(workspaceRoot, 'packages/config'), join(root, 'node_modules/@holo-js/config')),
    symlink(join(workspaceRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db')),
  ])

  return root
}

async function createAuthorizationProject(): Promise<string> {
  const root = await createProject()
  await mkdir(join(root, 'server/policies'), { recursive: true })
  await mkdir(join(root, 'server/abilities'), { recursive: true })
  await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
  return root
}

function authorizationRegistry(policyNames: readonly string[], abilityNames: readonly string[], exportName = 'default'): GeneratedProjectRegistry {
  return {
    version: 1,
    generatedAt: '',
    paths: {
      models: 'server/models', migrations: 'server/db/migrations', seeders: 'server/db/seeders', commands: 'server/commands', jobs: 'server/jobs', events: 'server/events', listeners: 'server/listeners', broadcast: 'server/broadcast', channels: 'server/channels', authorizationPolicies: 'server/policies', authorizationAbilities: 'server/abilities', generatedSchema: '.holo-js/generated/schema.generated.ts',
    },
    models: [], migrations: [], seeders: [], commands: [], jobs: [], events: [], listeners: [], broadcast: [], channels: [],
    authorizationPolicies: policyNames.map(name => ({ name, sourcePath: `server/policies/${name}.ts`, exportName, target: 'Post', classActions: ['viewAny'], recordActions: [] })),
    authorizationAbilities: abilityNames.map(name => ({ name, sourcePath: `server/abilities/${name}.ts`, exportName })),
  }
}

afterEach(async () => {
  await resetOptionalHoloSubsystems()
  authorizationInternals.resetAuthorizationRuntimeState()
  authorizationInternals.resetAuthorizationAuthIntegration()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/core authorization boot integration', () => {
  it('boots auth without authorization when the optional package is missing', async () => {
    const root = await createProject()
    const loadedConfig = await loadConfigDirectory(root)
    const configureAuthorizationAuthIntegration = vi.fn()
    const resetAuthorizationAuthIntegration = vi.fn()
    const resetAuthorizationRuntimeState = vi.fn()
    const configureAuthRuntime = vi.fn()
    const resetAuthRuntime = vi.fn()
    const configureSessionRuntime = vi.fn()
    const resetSessionRuntime = vi.fn()

    const importOptionalModule = vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier: string) => {
      if (specifier === '@holo-js/session') {
        return {
          configureSessionRuntime,
          getSessionRuntime: () => ({ name: 'session-runtime' }),
          createDatabaseSessionStore: (adapter: {
            read(sessionId: string): Promise<unknown | null>
            write(record: unknown): Promise<void>
            delete(sessionId: string): Promise<void>
          }) => adapter,
          createFileSessionStore: (root: string) => ({
            read: async () => null,
            write: async () => {},
            delete: async () => {},
            root,
          }),
          resetSessionRuntime,
        }
      }

      if (specifier === '@holo-js/auth') {
        return {
          authRuntimeInternals: { configureRuntime: configureAuthRuntime },
          createAsyncAuthContext: () => ({
            activate() {},
            getSessionId() { return undefined },
            setSessionId() {},
            getCachedUser() { return null },
            setCachedUser() {},
          }),
          getAuthRuntime: () => ({
            user: async () => ({ id: 'user-1' }),
            guard: (name: string) => ({
              user: async () => ({ id: 'user-1', guard: name }),
            }),
          }),
          resetAuthRuntime,
        }
      }

      if (specifier === '@holo-js/authorization') {
        return undefined
      }

      return undefined
    })

    await expect(reconfigureOptionalHoloSubsystems(root, loadedConfig)).resolves.toEqual(expect.objectContaining({
      auth: expect.any(Object),
    }))
    expect(configureAuthRuntime).toHaveBeenCalledTimes(1)
    expect(configureAuthorizationAuthIntegration).not.toHaveBeenCalled()

    await resetOptionalHoloSubsystems()
    expect(resetAuthRuntime).toHaveBeenCalled()
    expect(resetSessionRuntime).toHaveBeenCalled()

    importOptionalModule.mockRestore()
    expect(resetAuthorizationAuthIntegration).toBeDefined()
    expect(resetAuthorizationRuntimeState).toBeDefined()
  })

  it('wires authorization to auth when both optional packages are present', async () => {
    const root = await createProject()
    const loadedConfig = await loadConfigDirectory(root)
    const configureAuthorizationAuthIntegration = vi.fn()
    const resetAuthorizationAuthIntegration = vi.fn()
    const resetAuthorizationRuntimeState = vi.fn()
    const configureAuthRuntime = vi.fn()
    const resetAuthRuntime = vi.fn()
    const configureSessionRuntime = vi.fn()
    const resetSessionRuntime = vi.fn()
    const authorizationCan = vi.fn(async () => true)

    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockImplementation(async (specifier: string) => {
      if (specifier === '@holo-js/session') {
        return {
          configureSessionRuntime,
          getSessionRuntime: () => ({ name: 'session-runtime' }),
          createDatabaseSessionStore: (adapter: {
            read(sessionId: string): Promise<unknown | null>
            write(record: unknown): Promise<void>
            delete(sessionId: string): Promise<void>
          }) => adapter,
          createFileSessionStore: (root: string) => ({
            read: async () => null,
            write: async () => {},
            delete: async () => {},
            root,
          }),
          resetSessionRuntime,
        }
      }

      if (specifier === '@holo-js/auth') {
        return {
          authRuntimeInternals: { configureRuntime: configureAuthRuntime },
          createAsyncAuthContext: () => ({
            activate() {},
            getSessionId() { return undefined },
            setSessionId() {},
            getCachedUser() { return null },
            setCachedUser() {},
          }),
          getAuthRuntime: () => ({
            user: async () => ({ id: 'user-1' }),
            guard: (name: string) => ({
              user: async () => ({ id: 'user-1', guard: name }),
            }),
          }),
          resetAuthRuntime,
        }
      }

      if (specifier === '@holo-js/authorization') {
        return {
          isAuthorizationPolicyDefinition: () => false,
          isAuthorizationAbilityDefinition: () => false,
          forUser: () => ({
            can: authorizationCan,
          }),
          authorizationInternals: {
            getAuthorizationRuntimeState: () => ({
              policiesByName: new Map(),
              abilitiesByName: new Map(),
            }),
            getAuthorizationAuthIntegration() {
              return {
                hasGuard(guardName: string) {
                  return guardName === 'web'
                },
                resolveDefaultActor: async () => ({ id: 'user-1' }),
                resolveGuardActor: async (guardName: string) => ({ id: 'user-1', guard: guardName }),
              }
            },
            configureAuthorizationAuthIntegration,
            resetAuthorizationAuthIntegration,
            resetAuthorizationRuntimeState,
            unregisterPolicyDefinition: vi.fn(),
            unregisterAbilityDefinition: vi.fn(),
          },
        }
      }

      return undefined
    })

    await expect(reconfigureOptionalHoloSubsystems(root, loadedConfig)).resolves.toBeDefined()

    expect(configureAuthorizationAuthIntegration).toHaveBeenCalledTimes(1)
    expect(configureAuthRuntime.mock.calls[0]?.[0]?.authorization).toEqual({
      can: expect.any(Function),
    })
    await expect(configureAuthRuntime.mock.calls[0]?.[0]?.authorization?.can({ id: 'user-1' }, 'viewAny', {})).resolves.toBe(true)
    expect(authorizationCan).toHaveBeenCalledWith('viewAny', {})
    const integration = configureAuthorizationAuthIntegration.mock.calls[0]?.[0]
    expect(integration?.hasGuard('web')).toBe(true)
    expect(integration?.hasGuard('missing')).toBe(false)
    await expect(integration?.resolveDefaultActor()).resolves.toEqual({ id: 'user-1' })
    await expect(integration?.resolveGuardActor('web')).resolves.toEqual({ id: 'user-1', guard: 'web' })

    await resetOptionalHoloSubsystems()
    expect(resetAuthorizationAuthIntegration).toHaveBeenCalledTimes(1)
    expect(resetAuthorizationRuntimeState).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('preserves independent registrations while an installation awaits on %s', async (ending) => {
    let release = () => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    const installation = authorizationInternals.installAuthorizationDefinitions([], [{
      name: 'installed',
      async load() {
        defineAbility('import-side-effect', () => true)
        await pending
        if (ending === 'failure') throw new Error('Import failed')
        return defineAbility('installed', () => true)
      },
    }])
    defineAbility('independent', () => false)
    class IndependentTarget {}
    definePolicy('independent-policy', IndependentTarget, { class: { viewAny: () => false } })
    release()
    if (ending === 'failure') await expect(installation).rejects.toThrow('Import failed')
    else (await installation).dispose()
    expect((await authorizationInternals.evaluateAbility({}, 'independent', {})).allowed).toBe(false)
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', IndependentTarget)).allowed).toBe(false)
    await expect(authorizationInternals.evaluateAbility({}, 'import-side-effect', {})).rejects.toThrow('was not found')
  })

  it('does not restore a replaced name after its owned definition was independently removed', async () => {
    defineAbility('canonical', () => false)
    const registration = await authorizationInternals.installAuthorizationDefinitions([], [{ name: 'canonical', load: async () => defineAbility('canonical', () => true) }])
    authorizationInternals.unregisterAbilityDefinition('canonical')
    registration.dispose()
    await expect(authorizationInternals.evaluateAbility({}, 'canonical', {})).rejects.toThrow('was not found')
  })

  it('restores a cached definition alias after canonical installation is disposed', async () => {
    const ability = defineAbility('alias', () => false)
    const registration = await authorizationInternals.installAuthorizationDefinitions([], [{ name: 'canonical', load: async () => ability }])
    expect((await authorizationInternals.evaluateAbility({}, 'canonical', {})).allowed).toBe(false)
    registration.dispose()
    expect((await authorizationInternals.evaluateAbility({}, 'alias', {})).allowed).toBe(false)
    await expect(authorizationInternals.evaluateAbility({}, 'canonical', {})).rejects.toThrow('was not found')
  })

  it('rolls back import-time definitions when a project module throws', async () => {
    const root = await createAuthorizationProject()
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
defineAbility('side-effect', () => true)
throw new Error('Import failed')
`)
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry([], ['reports.export']), authorizationModule)).rejects.toThrow('Import failed')
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
    await expect(authorizationInternals.evaluateAbility({}, 'side-effect', {})).rejects.toThrow('was not found')
  })

  it('restores displaced definitions and target lookup after disposal', async () => {
    const root = await createAuthorizationProject()
    class ExistingPost {}
    definePolicy('posts', ExistingPost, { class: { viewAny: () => false } })
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
`)
    const registration = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry(['posts'], ['reports.export']), authorizationModule)
    const target = authorizationInternals.getPolicyByName('posts').target
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', target)).allowed).toBe(true)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(true)
    registration.dispose()
    registration.dispose()
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', ExistingPost)).allowed).toBe(false)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', target)).rejects.toThrow('was not found')
  })

  it('rejects unrelated target collisions without damaging model-definition lookup', async () => {
    const root = await createAuthorizationProject()
    const Post = {
      definition: { name: 'Post', table: { tableName: 'posts' } },
      query: () => ({ first: async () => undefined, firstOrFail: async () => ({ id: 1 }) }),
    }
    definePolicy('unrelated', Post, { class: { viewAny: () => false } })
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
const Post = {
  definition: { name: 'Post', table: { tableName: 'posts' } },
  query: () => ({ first: async () => undefined, firstOrFail: async () => ({ id: 1 }) }),
}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry(['posts'], []), authorizationModule)).rejects.toThrow('already registered')
    const reloadedPost = { ...Post, definition: { ...Post.definition } }
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', reloadedPost)).allowed).toBe(false)
  })

  it('removes owned grants and restores unaffected definitions when a displaced target has a newer owner', async () => {
    const root = await createAuthorizationProject()
    class PreviousPost {}
    class PreviousReport {}
    definePolicy('posts', PreviousPost, { class: { viewAny: () => false } })
    definePolicy('reports', PreviousReport, { class: { viewAny: () => false } })
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await writeFile(join(root, 'server/policies/reports.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Report {}
export default definePolicy('reports', Report, { class: { viewAny: () => true } })
`)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
`)
    const registration = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry(['posts', 'reports'], ['reports.export']), authorizationModule)
    const installedTarget = authorizationInternals.getPolicyByName('posts').target
    definePolicy('new-owner', PreviousPost, { class: { viewAny: () => true } })
    expect(() => registration.dispose()).toThrow('already registered')
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', installedTarget)).rejects.toThrow('was not found')
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', PreviousPost)).allowed).toBe(true)
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', PreviousReport)).allowed).toBe(false)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
  })

  it('restores optional capability bindings when authorization disposal fails during shutdown', async () => {
    const root = await createAuthorizationProject()
    await writeFile(join(root, 'config/database.ts'), `export default { defaultConnection: 'default', connections: { default: { driver: 'sqlite', url: ':memory:' } } }`)
    await rm(join(root, 'config/auth.ts'))
    await rm(join(root, 'config/session.ts'))
    await mkdir(join(root, '.holo-js/generated'), { recursive: true })
    await writeFile(join(root, '.holo-js/generated/registry.json'), JSON.stringify(authorizationRegistry(['posts'], [])))
    class PreviousPost {}
    definePolicy('posts', PreviousPost, { class: { viewAny: () => false } })
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    configureQueueRuntime({ config: { default: 'sync', connections: { sync: { driver: 'sync', queue: 'borrowed' } } } })
    const runtime = await createHolo(root)
    await runtime.initialize()
    const installedTarget = authorizationInternals.getPolicyByName('posts').target
    definePolicy('new-owner', PreviousPost, { class: { viewAny: () => true } })
    await expect(runtime.shutdown()).rejects.toThrow('already registered')
    expect(getQueueRuntime().config.connections.sync?.queue).toBe('borrowed')
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', installedTarget)).rejects.toThrow('was not found')
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', PreviousPost)).allowed).toBe(true)
  })

  it('reports every rollback restoration failure while removing owned grants and restoring unaffected definitions', async () => {
    class PreviousPost {}
    class PreviousReport {}
    class InstalledPost {}
    class InstalledReport {}
    definePolicy('posts', PreviousPost, { class: { viewAny: () => false } })
    definePolicy('reports', PreviousReport, { class: { viewAny: () => false } })
    defineAbility('reports.export', () => false)
    let release = () => {}
    let loaded = () => {}
    const pending = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { loaded = resolve })
    const importError = new Error('Import failed')
    const installation = authorizationInternals.installAuthorizationDefinitions([
      {
        name: 'posts',
        async load() {
          definePolicy('posts', InstalledPost, { class: { viewAny: () => true } })
          return authorizationInternals.getPolicyByName('posts')
        },
      },
      {
        name: 'reports',
        async load() {
          definePolicy('reports', InstalledReport, { class: { viewAny: () => true } })
          return authorizationInternals.getPolicyByName('reports')
        },
      },
    ], [{
      name: 'reports.export',
      async load() {
        defineAbility('reports.export', () => true)
        defineAbility('import-side-effect', () => true)
        loaded()
        await pending
        throw importError
      },
    }])
    await ready
    definePolicy('new-post-owner', PreviousPost, { class: { viewAny: () => true } })
    definePolicy('new-report-owner', PreviousReport, { class: { viewAny: () => true } })
    release()
    const failure = await installation.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw failure
    expect(failure.errors).toEqual([importError, expect.any(AggregateError)])
    expect(failure.errors[1]).toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', InstalledPost)).rejects.toThrow('was not found')
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', InstalledReport)).rejects.toThrow('was not found')
    await expect(authorizationInternals.evaluateAbility({}, 'import-side-effect', {})).rejects.toThrow('was not found')
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', PreviousPost)).allowed).toBe(true)
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', PreviousReport)).allowed).toBe(true)
  })

  it('preserves a newer definition when an older installation is disposed', async () => {
    const root = await createAuthorizationProject()
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
`)
    const registration = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry([], ['reports.export']), authorizationModule)
    authorizationInternals.unregisterAbilityDefinition('reports.export')
    defineAbility('reports.export', () => authorizationModule.denyAsNotFound())
    registration.dispose()
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).status).toBe(404)
  })

  it.each(['older-first', 'newer-first'] as const)('restores the original definitions after overlapping installations are disposed %s', async (order) => {
    const root = await createAuthorizationProject()
    class OriginalPost {}
    definePolicy('posts', OriginalPost, { class: { viewAny: () => false } })
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('reports.export', () => true)
`)
    const registry = authorizationRegistry(['posts'], ['reports.export'])
    const older = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, registry, authorizationModule)
    const olderTarget = authorizationInternals.getPolicyByName('posts').target
    const newer = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, registry, authorizationModule)
    const installedTarget = authorizationInternals.getPolicyByName('posts').target
    const [first, last] = order === 'older-first' ? [older, newer] : [newer, older]
    first.dispose()
    const remainingTarget = order === 'older-first' ? installedTarget : olderTarget
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', remainingTarget)).allowed).toBe(true)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(true)
    last.dispose()
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', OriginalPost)).allowed).toBe(false)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
    await expect(authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', installedTarget)).rejects.toThrow('was not found')
  })

  it('canonicalizes named exports and preserves unrelated authorization and auth integration', async () => {
    const root = await createAuthorizationProject()
    defineAbility('unrelated', () => false)
    const integration = {
      hasGuard: () => true,
      resolveDefaultActor: () => ({ id: 1 }),
      resolveGuardActor: () => ({ id: 1 }),
    }
    authorizationInternals.configureAuthorizationAuthIntegration(integration)
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export const selected = definePolicy('drifted-posts', Post, { class: { viewAny: () => true } })
export default {}
`)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export const selected = defineAbility('drifted-export', () => true)
export default {}
`)
    const registry = authorizationRegistry(['posts'], ['reports.export'], 'selected')
    const registration = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, registry, authorizationModule)
    expect(registration.policyNames).toEqual(['posts'])
    expect(registration.abilityNames).toEqual(['reports.export'])
    const target = authorizationInternals.getPolicyByName('posts').target
    expect((await authorizationInternals.evaluatePolicyByName({}, 'posts', 'viewAny', target)).allowed).toBe(true)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(true)
    await expect(authorizationInternals.evaluateAbility({}, 'drifted-export', {})).rejects.toThrow('was not found')
    expect(() => authorizationInternals.getPolicyByName('drifted-posts')).toThrow('was not found')
    registration.dispose()
    expect((await authorizationInternals.evaluateAbility({}, 'unrelated', {})).allowed).toBe(false)
    expect(authorizationInternals.getAuthorizationAuthIntegration()).toBe(integration)
  })

  it('restores earlier policy changes when a later ability import fails', async () => {
    const root = await createAuthorizationProject()
    class Post {}
    definePolicy('posts', Post, { class: { viewAny: () => false } })
    defineAbility('reports.export', () => false)
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'
class Post {}
export default definePolicy('posts', Post, { class: { viewAny: () => true } })
`)
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'
export default defineAbility('drifted-export', () => true)
throw new Error('Later failure')
`)
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, authorizationRegistry(['posts'], ['reports.export']), authorizationModule)).rejects.toThrow('Later failure')
    expect((await authorizationInternals.evaluatePolicyByTarget({}, 'viewAny', Post)).allowed).toBe(false)
    expect((await authorizationInternals.evaluateAbility({}, 'reports.export', {})).allowed).toBe(false)
    await expect(authorizationInternals.evaluateAbility({}, 'drifted-export', {})).rejects.toThrow('was not found')
  })

  it.each(['policy', 'ability'] as const)('rejects invalid %s exports and rolls back import registrations', async (kind) => {
    const root = await createAuthorizationProject()
    const sourcePath = kind === 'policy' ? 'server/policies/posts.ts' : 'server/abilities/reports.export.ts'
    await writeFile(join(root, sourcePath), `
import { defineAbility } from '@holo-js/authorization'
defineAbility('side-effect', () => true)
export default {}
`)
    const registry = authorizationRegistry(kind === 'policy' ? ['posts'] : [], kind === 'ability' ? ['reports.export'] : [])
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(root, registry, authorizationModule)).rejects.toThrow(`does not export a Holo ${kind}`)
    await expect(authorizationInternals.evaluateAbility({}, 'side-effect', {})).rejects.toThrow('was not found')
  })

  it('rejects missing authorization support only when project definitions need it', async () => {
    const empty = await holoRuntimeInternals.registerProjectAuthorizationDefinitions('/tmp/holo-authorization', authorizationRegistry([], []), undefined)
    expect(empty.policyNames).toEqual([])
    expect(empty.abilityNames).toEqual([])
    empty.dispose()
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions('/tmp/holo-authorization', authorizationRegistry(['posts'], []), undefined)).rejects.toThrow('requires @holo-js/authorization')
    vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockResolvedValueOnce(undefined)
    await expect(holoRuntimeInternals.loadAuthorizationModule(true)).rejects.toThrow('requires @holo-js/authorization')
  })
})
