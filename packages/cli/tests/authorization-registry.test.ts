import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as configModule from '@holo-js/config'
import { normalizeHoloProjectConfig } from '@holo-js/db'
import { authorizationInternals } from '../../authorization/src/index'
import { prepareProjectDiscovery } from '../src/project/discovery'
import { loadGeneratedProjectRegistry, renderGeneratedAuthorizationRegistry, renderGeneratedAuthorizationTypes, writeGeneratedProjectRegistry } from '../src/project/registry'
import type { GeneratedAuthorizationAbilityRegistryEntry, GeneratedAuthorizationPolicyRegistryEntry } from '../src/project/shared'

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')
const authorizationModulePath = join(workspaceRoot, 'packages/authorization/src/index.ts')
const authorizationContractsModulePath = join(workspaceRoot, 'packages/authorization/src/contracts.ts')

async function createProject(withAuthorizationFiles = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-authorization-registry-'))
  tempDirs.push(root)

  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await mkdir(join(root, 'server/policies/posts'), { recursive: true })
  await mkdir(join(root, 'server/abilities'), { recursive: true })

  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'authorization-registry-fixture',
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
    admin: {
      driver: 'session',
      provider: 'users',
    },
  },
})
`, 'utf8')

  await Promise.all([
    symlink(join(workspaceRoot, 'packages/config'), join(root, 'node_modules/@holo-js/config')),
    symlink(join(workspaceRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db')),
  ])

  if (withAuthorizationFiles) {
    await Promise.all([
      symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization')),
    ])
    await writeFile(join(root, 'server/policies/posts/index.ts'), `
import { definePolicy } from ${JSON.stringify(authorizationModulePath)}

class Post {
  constructor(readonly authorId: string) {}
}

export const postPolicy = definePolicy('posts', Post, {
  class: {
    create() {
      return true
    },
    viewAny() {
      return true
    },
  },
  record: {
    view() {
      return true
    },
    update() {
      return true
    },
  },
})
`, 'utf8')
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from ${JSON.stringify(authorizationModulePath)}

export default defineAbility('reports.export', (_context, input: { reportId: string, format: 'csv' | 'pdf' }) => input.format === 'csv')
`, 'utf8')
  }

  return root
}

afterEach(async () => {
  authorizationInternals.resetAuthorizationRuntimeState()
  authorizationInternals.resetAuthorizationAuthIntegration()
  vi.resetModules()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('@holo-js/cli authorization registry discovery', () => {
  it('writes empty authorization artifacts when no policy or ability files exist', async () => {
    const root = await createProject()

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(registry.authorizationPolicies).toEqual([])
    expect(registry.authorizationAbilities).toEqual([])
    await expect(loadGeneratedProjectRegistry(root)).resolves.toMatchObject({
      authorizationPolicies: [],
      authorizationAbilities: [],
    })
    await expect(readFile(join(root, '.holo-js/generated/authorization/registry.ts'), 'utf8')).resolves.toContain('export const authorization = {')
    await expect(readFile(join(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('declare module \'@holo-js/authorization/contracts\'')
    await expect(readFile(join(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('interface AuthorizationPolicyRegistry {}')
    await expect(readFile(join(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8')).resolves.toContain('interface AuthorizationAbilityRegistry {}')
  })

  it('discovers authorization policies and abilities and emits typed registry artifacts', async () => {
    const root = await createProject(true)

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    expect(registry.authorizationPolicies).toEqual([{
      sourcePath: 'server/policies/posts/index.ts',
      name: 'posts',
      exportName: 'postPolicy',
      target: 'Post',
      classActions: ['create', 'viewAny'],
      recordActions: ['view', 'update'],
    }])
    expect(registry.authorizationAbilities).toEqual([{
      sourcePath: 'server/abilities/reports.export.ts',
      name: 'reports.export',
      exportName: 'default',
    }])

    await expect(loadGeneratedProjectRegistry(root)).resolves.toMatchObject({
      authorizationPolicies: registry.authorizationPolicies,
      authorizationAbilities: registry.authorizationAbilities,
    })

    const types = await readFile(join(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8')
    expect(types).toContain('declare module \'@holo-js/authorization/contracts\'')
    expect(types).toContain('"posts"')
    expect(types).toContain('"reports.export"')
    expect(types).toContain('"web"')
    expect(types).toContain('"admin"')
    expect(types).toContain('AuthorizationPolicyRegistry')
    expect(types).toContain('AuthorizationAbilityRegistry')
    expect(types).toContain('AuthorizationGuardRegistry')
    expect(types).toContain('actor: typeof holoAuthorizationPolicyModule0["postPolicy"] extends import(\'@holo-js/authorization/contracts\').AuthorizationPolicyDefinition<infer _TName, infer _TTarget, infer _TClassActions, infer _TRecordActions, infer TActor> ? TActor : object')
    expect(types).toContain('actor: typeof holoAuthorizationAbilityModule0["default"] extends import(\'@holo-js/authorization/contracts\').AuthorizationAbilityDefinition<infer _TName, infer _TInput, infer TActor> ? TActor : object')
    expect(types).toContain('"web": {')
    expect(types).toContain('user: import(\'@holo-js/auth\').AuthUser')
    expect(types).toContain('"admin": {')
    expect(types).toContain('user: import(\'@holo-js/auth\').AuthUser')
  })

  it('renders fallback authorization registry types for JavaScript entries without import metadata', () => {
    const output = renderGeneratedAuthorizationTypes([
      {
        sourcePath: 'server/policies/posts.js',
        name: 'posts',
        target: 'Post',
        classActions: ['create'],
        recordActions: ['view'],
      },
    ] satisfies readonly GeneratedAuthorizationPolicyRegistryEntry[], [
      {
        sourcePath: 'server/abilities/reports.export.js',
        name: 'reports.export',
      },
    ] satisfies readonly GeneratedAuthorizationAbilityRegistryEntry[], ['web'])

    expect(output).toContain('"posts": {')
    expect(output).toContain('actor: object')
    expect(output).toContain('target: object')
    expect(output).toContain('"reports.export": {')
    expect(output).toContain('actor: object')
    expect(output).toContain('input: object')
    expect(output).toContain('"web": {')
    expect(output).toContain('user: import(\'@holo-js/auth\').AuthUser')
  })

  it('renders fallback authorization registry types for empty JavaScript policy actions', () => {
    const output = renderGeneratedAuthorizationTypes([
      {
        sourcePath: 'server/policies/plain.js',
        name: 'plain',
        target: 'Object',
        classActions: [],
        recordActions: [],
      },
    ] satisfies readonly GeneratedAuthorizationPolicyRegistryEntry[], [], ['web'])

    expect(output).toContain('"plain": {')
    expect(output).toContain('[key: string]: true')
  })

  it('renders authorization registry entries without optional export names', () => {
    const output = renderGeneratedAuthorizationRegistry({
      generatedAt: '2026-01-01T00:00:00.000Z',
      authorizationPolicies: [
        {
          sourcePath: 'server/policies/plain.ts',
          name: 'plain',
          target: 'Object',
          classActions: [],
          recordActions: [],
        },
        {
          sourcePath: 'server/policies/typed.ts',
          name: 'typed',
          exportName: 'typedPolicy',
          target: 'TypedTarget',
          classActions: ['create'],
          recordActions: ['view'],
        },
      ],
      authorizationAbilities: [
        {
          sourcePath: 'server/abilities/reports.export.js',
          name: 'reports.export',
        },
        {
          sourcePath: 'server/abilities/guarded.export.js',
          name: 'guarded.export',
          exportName: 'guardedExport',
        },
      ],
    })

    expect(output).toContain('"plain"')
    expect(output).toContain('"typed"')
    expect(output).toContain('"reports.export"')
    expect(output).toContain('"guarded.export"')
    expect(output).toContain('exportName: "guardedExport"')
  })

  it('uses empty authorization guards when the loaded config has no auth block', async () => {
    vi.spyOn(configModule, 'loadConfigDirectory').mockResolvedValue({} as Awaited<ReturnType<typeof configModule.loadConfigDirectory>>)

    const root = await createProject()
    await prepareProjectDiscovery(root, normalizeHoloProjectConfig())

    await expect(readFile(join(root, '.holo-js/generated/authorization/types.d.ts'), 'utf8'))
      .resolves.toContain('interface AuthorizationGuardRegistry {}')
  })

  it('surfaces auth config load failures while writing authorization types', async () => {
    const root = await createProject()
    const configError = new Error('broken auth config')

    vi.spyOn(configModule, 'loadConfigDirectory').mockRejectedValue(configError)

    await expect(writeGeneratedProjectRegistry(root, {
      version: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      paths: {
        models: 'server/models',
        migrations: 'server/db/migrations',
        seeders: 'server/db/seeders',
        commands: 'server/commands',
        jobs: 'server/jobs',
        events: 'server/events',
        listeners: 'server/listeners',
        broadcast: 'server/broadcast',
        channels: 'server/channels',
        authorizationPolicies: 'server/policies',
        authorizationAbilities: 'server/abilities',
        generatedSchema: 'server/db/schema.generated.ts',
      },
      models: [],
      migrations: [],
      seeders: [],
      commands: [],
      jobs: [],
      events: [],
      listeners: [],
      broadcast: [],
      channels: [],
      authorizationPolicies: [],
      authorizationAbilities: [],
    })).rejects.toThrow(configError)
  })

  it('fails when a discovered policy file does not export a Holo policy definition', async () => {
    const root = await createProject(true)
    await writeFile(join(root, 'server/policies/posts/index.ts'), 'export default {}\n', 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'Discovered policy "server/policies/posts/index.ts" does not export a Holo policy.',
    )
  })

  it('fails when a discovered ability file does not export a Holo ability definition', async () => {
    const root = await createProject()
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/abilities/reports.export.ts'), 'export default {}\n', 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'Discovered ability "server/abilities/reports.export.ts" does not export a Holo ability.',
    )
  })

  it('rejects policy files that register multiple policies and cleans up discovery state', async () => {
    const root = await createProject()
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/policies/posts/index.ts'), `
import { definePolicy } from ${JSON.stringify(authorizationModulePath)}

class Post {
  constructor(readonly authorId: string) {}
}

class HiddenPost {
  constructor(readonly authorId: string) {}
}

definePolicy('hidden-posts', HiddenPost, {
  record: {
    view() {
      return true
    },
  },
})

export const postPolicy = definePolicy('posts', Post, {
  record: {
    view() {
      return true
    },
  },
})
`, 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'Discovered policy "server/policies/posts/index.ts" must register exactly one Holo policy.',
    )
    expect([...authorizationInternals.getAuthorizationRuntimeState().policiesByName.keys()]).toEqual([])
  })

  it('rejects ability files that register multiple abilities and cleans up discovery state', async () => {
    const root = await createProject()
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/abilities/reports.export.ts'), `
import { defineAbility } from ${JSON.stringify(authorizationModulePath)}

defineAbility('hidden.export', () => true)

export default defineAbility('reports.export', () => true)
`, 'utf8')

    await expect(prepareProjectDiscovery(root, normalizeHoloProjectConfig())).rejects.toThrow(
      'Discovered ability "server/abilities/reports.export.ts" must register exactly one Holo ability.',
    )
    expect([...authorizationInternals.getAuthorizationRuntimeState().abilitiesByName.keys()]).toEqual([])
  })

  it('discovers policies without class or record blocks and works without auth guards configured', async () => {
    const root = await createProject()
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await rm(join(root, 'config/auth.ts'), { force: true })
    await writeFile(join(root, 'server/policies/plain.ts'), `
import { definePolicy } from ${JSON.stringify(authorizationModulePath)}

class PlainTarget {
  constructor(readonly id: string) {}
}

  export default definePolicy('plain', PlainTarget, {})
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())
    expect(registry.authorizationPolicies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'plain',
        target: 'PlainTarget',
        classActions: [],
        recordActions: [],
      }),
    ]))
  })

  it('uses the Object target fallback when a discovered policy target has no name', async () => {
    const root = await createProject()
    await symlink(join(workspaceRoot, 'packages/authorization'), join(root, 'node_modules/@holo-js/authorization'))
    await writeFile(join(root, 'server/policies/plain.ts'), `
import { AUTHORIZATION_POLICY_MARKER } from ${JSON.stringify(authorizationContractsModulePath)}

export default {
  [AUTHORIZATION_POLICY_MARKER]: true,
  name: 'plain',
  target: {},
  class: {},
  record: {},
}
`, 'utf8')

    const registry = await prepareProjectDiscovery(root, normalizeHoloProjectConfig())
    expect(registry.authorizationPolicies).toEqual([expect.objectContaining({
      name: 'plain',
      target: 'Object',
    })])
  })
})
