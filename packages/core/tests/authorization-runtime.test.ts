import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { authorizationInternals, defineAbility, definePolicy } from '@holo-js/authorization'
import { reconfigureOptionalHoloSubsystems, resetOptionalHoloSubsystems, holoRuntimeInternals } from '../src'

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
import { defineAuthConfig } from '@holo-js/config'

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
  await writeFile(join(root, 'server/models/User.ts'), 'export default {}', 'utf8')

  await Promise.all([
    symlink(join(workspaceRoot, 'packages/config'), join(root, 'node_modules/@holo-js/config')),
    symlink(join(workspaceRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db')),
  ])

  return root
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
          configureAuthRuntime,
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
          configureAuthRuntime,
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
    const integration = configureAuthorizationAuthIntegration.mock.calls[0]?.[0]
    expect(integration?.hasGuard('web')).toBe(true)
    expect(integration?.hasGuard('missing')).toBe(false)
    await expect(integration?.resolveDefaultActor()).resolves.toEqual({ id: 'user-1' })
    await expect(integration?.resolveGuardActor('web')).resolves.toEqual({ id: 'user-1', guard: 'web' })

    await resetOptionalHoloSubsystems()
    expect(resetAuthorizationAuthIntegration).toHaveBeenCalledTimes(1)
    expect(resetAuthorizationRuntimeState).not.toHaveBeenCalled()
  })

  it('covers the project authorization helper fallbacks directly', async () => {
    const namedDefinition = { name: 'posts' }
    expect(
      holoRuntimeInternals.resolveAuthorizationDefinitionExport({
        default: { name: 'default' },
        named: namedDefinition,
      }, value => value === namedDefinition),
    ).toBe(namedDefinition)

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      '/tmp/holo-authorization',
      {
        authorizationPolicies: [],
        authorizationAbilities: [],
      } as never,
      undefined,
    )).resolves.toEqual({
      policyNames: [],
      abilityNames: [],
    })

    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await mkdir(join(root, 'server/abilities'), { recursive: true })
    await writeFile(join(root, 'server/policies/posts.ts'), `
export default {
  name: 'posts',
}
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
export const reportAbility = {
  name: 'reports.export',
}

export default reportAbility
`, 'utf8')

    const authorizationModule = {
      isAuthorizationPolicyDefinition(value: unknown) {
        return !!value && typeof value === 'object' && 'name' in value && (value as { name?: unknown }).name === 'posts'
      },
      isAuthorizationAbilityDefinition(value: unknown) {
        return !!value && typeof value === 'object' && 'name' in value && (value as { name?: unknown }).name === 'reports.export'
      },
      authorizationInternals: {
        getAuthorizationRuntimeState: () => ({
          policiesByName: new Map(),
          abilitiesByName: new Map(),
        }),
        configureAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationRuntimeState: vi.fn(),
        unregisterPolicyDefinition: vi.fn(),
        unregisterAbilityDefinition: vi.fn(),
      },
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      authorizationModule as never,
    )).resolves.toEqual({
      policyNames: ['posts'],
      abilityNames: ['reports.export'],
    })
  })

  it('preserves configured authorization auth integration when loading project definitions', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await mkdir(join(root, 'server/abilities'), { recursive: true })
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'

class Post {}

export default definePolicy('posts', Post, {
  record: {
    view() {
      return true
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'

export default defineAbility('reports.export', () => true)
`, 'utf8')

    class ExistingPost {}
    definePolicy('existing-posts', ExistingPost, {
      record: {
        view() {
          return true
        },
      },
    })
    defineAbility('existing.reports.export', () => true)

    const integration = {
      hasGuard: vi.fn((guardName: string) => guardName === 'web'),
      resolveDefaultActor: vi.fn(async () => ({ id: 'user-1' })),
      resolveGuardActor: vi.fn(async (guardName: string) => ({ id: 'user-1', guard: guardName })),
    }
    authorizationInternals.configureAuthorizationAuthIntegration(integration)

    await holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      {
        isAuthorizationPolicyDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        isAuthorizationAbilityDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        authorizationInternals,
      } as never,
    )

    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.has('existing-posts')).toBe(true)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('existing.reports.export')).toBe(true)
    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.has('posts')).toBe(true)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('reports.export')).toBe(true)
    expect(() => authorizationInternals.getAuthorizationAuthIntegration()).not.toThrow()
    expect(authorizationInternals.getAuthorizationAuthIntegration()).toBe(integration)
  })

  it('replaces existing project-owned definitions before loading updated authorization modules', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await mkdir(join(root, 'server/abilities'), { recursive: true })
    await writeFile(join(root, 'server/policies/posts.ts'), `
export default {
  name: 'posts',
}
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
export default {
  name: 'reports.export',
}
`, 'utf8')

    const unregisterPolicyDefinition = vi.fn()
    const unregisterAbilityDefinition = vi.fn()
    const runtimeState = {
      policiesByName: new Map<string, unknown>([['posts', { sourcePath: 'server/policies/posts.ts' }]]),
      abilitiesByName: new Map<string, unknown>([['reports.export', { sourcePath: 'server/abilities/reports.export.ts' }]]),
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      {
        isAuthorizationPolicyDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        isAuthorizationAbilityDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        authorizationInternals: {
          getAuthorizationRuntimeState: () => runtimeState,
          getAuthorizationAuthIntegration: vi.fn(),
          configureAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationRuntimeState: vi.fn(),
          unregisterPolicyDefinition,
          unregisterAbilityDefinition,
        },
      } as never,
    )).resolves.toEqual({
      policyNames: ['posts'],
      abilityNames: ['reports.export'],
    })

    expect(unregisterPolicyDefinition).toHaveBeenCalledWith('posts')
    expect(unregisterAbilityDefinition).toHaveBeenCalledWith('reports.export')
  })

  it('uses registry policy names when project policy exports drift before prepare reruns', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await mkdir(join(root, 'server/abilities'), { recursive: true })
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/policies/posts.ts'), `
import { definePolicy } from '@holo-js/authorization'

class Post {}

export default definePolicy('renamed-posts', Post, {
  record: {
    view() {
      return true
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from '@holo-js/authorization'

export default defineAbility('renamed.reports.export', () => true)
`, 'utf8')

    const registration = await holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      {
        isAuthorizationPolicyDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        isAuthorizationAbilityDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        authorizationInternals,
      } as never,
    )

    expect(registration).toEqual({
      policyNames: ['posts'],
      abilityNames: ['reports.export'],
    })
    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.has('posts')).toBe(true)
    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.has('renamed-posts')).toBe(false)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('reports.export')).toBe(true)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('renamed.reports.export')).toBe(false)

    holoRuntimeInternals.unregisterProjectAuthorizationDefinitions(
      {
        authorizationInternals,
      } as never,
      registration.policyNames,
      registration.abilityNames,
    )

    expect(authorizationInternals.getAuthorizationRuntimeState().policiesByName.has('posts')).toBe(false)
    expect(authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.has('reports.export')).toBe(false)
  })

  it('keeps the previously registered authorization definitions when reloading updated modules fails', async () => {
    const unregisterPolicyDefinition = vi.fn((name: string) => {
      runtimeState.policiesByName.delete(name)
    })
    const unregisterAbilityDefinition = vi.fn((name: string) => {
      runtimeState.abilitiesByName.delete(name)
    })
    const registerPolicyDefinition = vi.fn((definition: unknown) => {
      const resolvedDefinition = definition as { name: string }
      runtimeState.policiesByName.set(resolvedDefinition.name, resolvedDefinition)
      return definition
    })
    const registerAbilityDefinition = vi.fn((definition: unknown) => {
      const resolvedDefinition = definition as { name: string }
      runtimeState.abilitiesByName.set(resolvedDefinition.name, resolvedDefinition)
      return definition
    })
    const runtimeState = {
      policiesByName: new Map<string, unknown>([['posts', { name: 'posts', version: 'stable' }]]),
      abilitiesByName: new Map<string, unknown>([['reports.export', { name: 'reports.export', version: 'stable' }]]),
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      '/tmp/holo-authorization',
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      {
        isAuthorizationPolicyDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        isAuthorizationAbilityDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        authorizationInternals: {
          getAuthorizationRuntimeState: () => runtimeState,
          getAuthorizationAuthIntegration: vi.fn(),
          registerPolicyDefinition,
          registerAbilityDefinition,
          configureAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationRuntimeState: vi.fn(),
          unregisterPolicyDefinition,
          unregisterAbilityDefinition,
        },
      } as never,
    )).rejects.toThrow()

    expect(registerPolicyDefinition).toHaveBeenCalledWith({ name: 'posts', version: 'stable' })
    expect(registerAbilityDefinition).not.toHaveBeenCalled()
    expect(runtimeState.policiesByName.get('posts')).toEqual({ name: 'posts', version: 'stable' })
    expect(runtimeState.abilitiesByName.get('reports.export')).toEqual({ name: 'reports.export', version: 'stable' })
  })

  it('restores a previous ability definition when reloading abilities fails', async () => {
    const unregisterPolicyDefinition = vi.fn((name: string) => {
      runtimeState.policiesByName.delete(name)
    })
    const unregisterAbilityDefinition = vi.fn((name: string) => {
      runtimeState.abilitiesByName.delete(name)
    })
    const registerPolicyDefinition = vi.fn((definition: unknown) => {
      const resolvedDefinition = definition as { name: string }
      runtimeState.policiesByName.set(resolvedDefinition.name, resolvedDefinition)
      return definition
    })
    const registerAbilityDefinition = vi.fn((definition: unknown) => {
      const resolvedDefinition = definition as { name: string }
      runtimeState.abilitiesByName.set(resolvedDefinition.name, resolvedDefinition)
      return definition
    })
    const runtimeState = {
      policiesByName: new Map<string, unknown>(),
      abilitiesByName: new Map<string, unknown>([['reports.export', { name: 'reports.export', version: 'stable' }]]),
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      '/tmp/holo-authorization',
      {
        authorizationPolicies: [],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      {
        isAuthorizationPolicyDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        isAuthorizationAbilityDefinition: (value: unknown) => typeof value === 'object' && value !== null && 'name' in value,
        authorizationInternals: {
          getAuthorizationRuntimeState: () => runtimeState,
          getAuthorizationAuthIntegration: vi.fn(),
          registerPolicyDefinition,
          registerAbilityDefinition,
          configureAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationAuthIntegration: vi.fn(),
          resetAuthorizationRuntimeState: vi.fn(),
          unregisterPolicyDefinition,
          unregisterAbilityDefinition,
        },
      } as never,
    )).rejects.toThrow()

    expect(registerPolicyDefinition).not.toHaveBeenCalled()
    expect(registerAbilityDefinition).toHaveBeenCalledWith({ name: 'reports.export', version: 'stable' })
    expect(runtimeState.abilitiesByName.get('reports.export')).toEqual({ name: 'reports.export', version: 'stable' })
  })

  it('rejects project authorization registration when registry entries exist but the package is missing', async () => {
    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      '/tmp/holo-authorization',
      {
        authorizationPolicies: [
          {
            sourcePath: 'server/policies/posts.ts',
            name: 'posts',
            exportName: 'default',
          },
        ],
        authorizationAbilities: [],
      } as never,
      undefined,
    )).rejects.toThrow(
      '[@holo-js/core] Authorization support requires @holo-js/authorization to be installed.',
    )
  })

  it('unregisters project authorization definitions only when a module is present', () => {
    const unregisterPolicyDefinition = vi.fn()
    const unregisterAbilityDefinition = vi.fn()

    holoRuntimeInternals.unregisterProjectAuthorizationDefinitions(undefined, ['posts'], ['reports.export'])
    holoRuntimeInternals.unregisterProjectAuthorizationDefinitions({
      authorizationInternals: {
        unregisterPolicyDefinition,
        unregisterAbilityDefinition,
      },
    } as never, ['posts'], ['reports.export'])

    expect(unregisterPolicyDefinition).toHaveBeenCalledWith('posts')
    expect(unregisterAbilityDefinition).toHaveBeenCalledWith('reports.export')
  })

  it('rejects required authorization module loading when the package is missing', async () => {
    const importOptionalModule = vi.spyOn(holoRuntimeInternals.moduleInternals, 'importOptionalModule').mockResolvedValueOnce(undefined)

    await expect(holoRuntimeInternals.loadAuthorizationModule(true)).rejects.toThrow(
      '[@holo-js/core] Authorization support requires @holo-js/authorization to be installed.',
    )

    importOptionalModule.mockRestore()
  })

  it('rejects authorization policy files that do not export a valid policy', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await writeFile(join(root, 'server/policies/posts.ts'), `
export default {
  name: 'wrong',
}
`, 'utf8')

    const authorizationModule = {
      isAuthorizationPolicyDefinition(value: unknown) {
        return !!value && typeof value === 'object' && 'name' in value && (value as { name?: unknown }).name === 'posts'
      },
      isAuthorizationAbilityDefinition() {
        return false
      },
      authorizationInternals: {
        getAuthorizationRuntimeState: () => ({
          policiesByName: new Map(),
          abilitiesByName: new Map(),
        }),
        configureAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationRuntimeState: vi.fn(),
        unregisterPolicyDefinition: vi.fn(),
        unregisterAbilityDefinition: vi.fn(),
      },
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [],
      } as never,
      authorizationModule as never,
    )).rejects.toThrow('Discovered policy "server/policies/posts.ts" does not export a Holo policy.')
  })

  it('rejects authorization ability files that do not export a valid ability', async () => {
    const root = await createProject()
    await mkdir(join(root, 'server/policies'), { recursive: true })
    await mkdir(join(root, 'server/abilities'), { recursive: true })
    await writeFile(join(root, 'server/policies/posts.ts'), `
export default {
  name: 'posts',
}
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
export default {
  name: 'wrong',
}
`, 'utf8')

    const authorizationModule = {
      isAuthorizationPolicyDefinition(value: unknown) {
        return !!value && typeof value === 'object' && 'name' in value && (value as { name?: unknown }).name === 'posts'
      },
      isAuthorizationAbilityDefinition(value: unknown) {
        return !!value && typeof value === 'object' && 'name' in value && (value as { name?: unknown }).name === 'reports.export'
      },
      authorizationInternals: {
        getAuthorizationRuntimeState: () => ({
          policiesByName: new Map(),
          abilitiesByName: new Map(),
        }),
        configureAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationAuthIntegration: vi.fn(),
        resetAuthorizationRuntimeState: vi.fn(),
        unregisterPolicyDefinition: vi.fn(),
        unregisterAbilityDefinition: vi.fn(),
      },
    }

    await expect(holoRuntimeInternals.registerProjectAuthorizationDefinitions(
      root,
      {
        authorizationPolicies: [{
          sourcePath: 'server/policies/posts.ts',
          name: 'posts',
          exportName: 'default',
        }],
        authorizationAbilities: [{
          sourcePath: 'server/abilities/reports.export.ts',
          name: 'reports.export',
          exportName: 'default',
        }],
      } as never,
      authorizationModule as never,
    )).rejects.toThrow('Discovered ability "server/abilities/reports.export.ts" does not export a Holo ability.')
  })
})
