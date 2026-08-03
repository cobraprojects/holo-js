import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { upsertProjectDependency } from '../src/package-json'
import { resolveWorkspacePackageNames } from '../src/project/workspaces'

const temporaryDirectories: string[] = []

async function createWorkspace(): Promise<Readonly<{ appRoot: string, root: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-workspace-dependencies-'))
  temporaryDirectories.push(root)
  const appRoot = join(root, 'apps/application')
  await mkdir(appRoot, { recursive: true })
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'workspace-root',
    private: true,
    workspaces: ['apps/*', 'packages/*'],
  }, null, 2)}\n`)
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({
    name: 'application',
    private: true,
    dependencies: {
      '@holo-js/auth': 'catalog:',
      '@holo-js/panels': 'workspace:*',
    },
  }, null, 2)}\n`)
  const panelsRoot = join(root, 'packages/panels')
  await mkdir(panelsRoot, { recursive: true })
  await writeFile(join(panelsRoot, 'package.json'), `${JSON.stringify({ name: '@holo-js/panels', version: '0.1.0' }, null, 2)}\n`)
  return { appRoot, root }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('workspace dependency resolution', () => {
  it('discovers only package names declared by the containing workspace', async () => {
    const { appRoot } = await createWorkspace()

    await expect(resolveWorkspacePackageNames(appRoot)).resolves.toEqual(new Set(['@holo-js/panels', 'application']))
  })

  it('discovers packages nested below globstar workspace directories', async () => {
    const { appRoot, root } = await createWorkspace()
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['apps/*', 'packages/**'],
    }, null, 2)}\n`)
    const nestedPackageRoot = join(root, 'packages/extensions/audit')
    await mkdir(nestedPackageRoot, { recursive: true })
    await writeFile(join(nestedPackageRoot, 'package.json'), `${JSON.stringify({
      name: '@holo-js/audit',
      version: '0.1.0',
    }, null, 2)}\n`)

    await expect(resolveWorkspacePackageNames(appRoot)).resolves.toEqual(new Set([
      '@holo-js/audit',
      '@holo-js/panels',
      'application',
    ]))
  })

  it('discovers packages declared through brace and character-class workspace globs', async () => {
    const { appRoot, root } = await createWorkspace()
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['{apps,packages}/[ap]*'],
    }, null, 2)}\n`)

    await expect(resolveWorkspacePackageNames(appRoot)).resolves.toEqual(new Set(['@holo-js/panels', 'application']))
  })

  it('discovers packages declared by a pnpm workspace manifest', async () => {
    const { appRoot, root } = await createWorkspace()
    await writeFile(join(root, 'package.json'), `${JSON.stringify({
      name: 'workspace-root',
      private: true,
    }, null, 2)}\n`)
    await writeFile(join(root, 'pnpm-workspace.yaml'), [
      'packages:',
      "  - 'apps/*'",
      "  - 'packages/*'",
      '',
    ].join('\n'))

    await expect(resolveWorkspacePackageNames(appRoot)).resolves.toEqual(new Set(['@holo-js/panels', 'application']))
  })

  it('does not propagate a workspace plugin protocol to external Holo packages', async () => {
    const { appRoot } = await createWorkspace()

    await expect(upsertProjectDependency(appRoot, '@holo-js/security')).resolves.toBe(true)
    const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
      readonly dependencies: Readonly<Record<string, string>>
    }

    expect(manifest.dependencies['@holo-js/panels']).toBe('workspace:*')
    expect(manifest.dependencies['@holo-js/security']).toMatch(/^\^\d/u)
  })

  it('uses workspace protocol only for a dependency that belongs to the workspace', async () => {
    const { appRoot } = await createWorkspace()

    await expect(upsertProjectDependency(appRoot, '@holo-js/panels')).resolves.toBe(false)
    await expect(upsertProjectDependency(appRoot, '@holo-js/auth')).resolves.toBe(false)
    const manifest = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
      readonly dependencies: Readonly<Record<string, string>>
    }

    expect(manifest.dependencies).toMatchObject({
      '@holo-js/auth': 'catalog:',
      '@holo-js/panels': 'workspace:*',
    })
  })
})
