import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRealtimeDefinitionTree, isInRealtimeDefinitionDirectory, resolveRealtimeDefinitionDirectories } from '../src/realtime-directories'

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(workspace => rm(workspace, { recursive: true, force: true })))
})

async function createWorkspace(): Promise<string> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'holo-realtime-directories-')))
  workspaces.push(workspace)
  return workspace
}

describe('realtime definition directories', () => {
  it('matches module ids through a symlinked project root', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'project/server/realtime'), { recursive: true })
    await symlink(join(workspace, 'project'), join(workspace, 'linked'), 'dir')
    const directories = resolveRealtimeDefinitionDirectories(join(workspace, 'linked'))

    expect(isInRealtimeDefinitionDirectory(directories, join(workspace, 'project/server/realtime/posts.ts'))).toBe(true)
    expect(isInRealtimeDefinitionDirectory(directories, `${join(workspace, 'linked/server/realtime/posts.ts')}?v=1`)).toBe(true)
    expect(isInRealtimeDefinitionDirectory(directories, join(workspace, 'project/server/models/Post.ts'))).toBe(false)
  })

  it('matches module ids through a symlinked realtime directory', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'project/server'), { recursive: true })
    await mkdir(join(workspace, 'shared-realtime'))
    await symlink(join(workspace, 'shared-realtime'), join(workspace, 'project/server/realtime'), 'dir')
    const directories = resolveRealtimeDefinitionDirectories(join(workspace, 'project'))

    expect(isInRealtimeDefinitionDirectory(directories, join(workspace, 'shared-realtime/posts.ts'))).toBe(true)
    expect(isInRealtimeDefinitionDirectory(directories, join(workspace, 'shared-realtime-other/posts.ts'))).toBe(false)
  })

  it('keeps the configured directory for roots that do not exist, in POSIX or Windows form', () => {
    expect(isInRealtimeDefinitionDirectory(resolveRealtimeDefinitionDirectories('/app/'), '/app/server/realtime/posts.ts')).toBe(true)
    expect(isInRealtimeDefinitionDirectory(resolveRealtimeDefinitionDirectories('C:\\app'), 'C:\\app\\server\\realtime\\posts.ts')).toBe(true)
  })

  it('rejects a symlinked file inside the realtime folder, naming the link', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'project/server/realtime/admin'), { recursive: true })
    await writeFile(join(workspace, 'shared-posts.ts'), 'export const posts = 1\n')
    await symlink(join(workspace, 'shared-posts.ts'), join(workspace, 'project/server/realtime/admin/posts.ts'))

    expect(() => resolveRealtimeDefinitionDirectories(join(workspace, 'project'))).toThrow(
      'server/realtime/admin/posts.ts is a symbolic link; Holo can\'t guarantee its server code stays out of the browser bundle. Replace it with a regular file.',
    )
    expect(() => assertRealtimeDefinitionTree(join(workspace, 'project'))).toThrow('server/realtime/admin/posts.ts')
  })

  it('rejects a symlinked folder that points outside the realtime folder, and a broken link', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'project/server/realtime'), { recursive: true })
    await mkdir(join(workspace, 'elsewhere'))
    await symlink(join(workspace, 'elsewhere'), join(workspace, 'project/server/realtime/shared'), 'dir')
    expect(() => assertRealtimeDefinitionTree(join(workspace, 'project'))).toThrow('server/realtime/shared is a symbolic link')

    await rm(join(workspace, 'project/server/realtime/shared'))
    await symlink(join(workspace, 'missing.ts'), join(workspace, 'project/server/realtime/missing.ts'))
    expect(() => assertRealtimeDefinitionTree(join(workspace, 'project'))).toThrow('server/realtime/missing.ts is a symbolic link')
  })

  it('accepts a symlinked folder inside the realtime folder and a symlinked realtime folder itself', async () => {
    const workspace = await createWorkspace()
    await mkdir(join(workspace, 'shared-realtime/posts'), { recursive: true })
    await writeFile(join(workspace, 'shared-realtime/posts/index.ts'), 'export const posts = 1\n')
    await symlink(join(workspace, 'shared-realtime/posts'), join(workspace, 'shared-realtime/latest'), 'dir')
    await mkdir(join(workspace, 'project/server'), { recursive: true })
    await symlink(join(workspace, 'shared-realtime'), join(workspace, 'project/server/realtime'), 'dir')

    expect(() => assertRealtimeDefinitionTree(join(workspace, 'project'))).not.toThrow()
    expect(() => assertRealtimeDefinitionTree(join(workspace, 'no-project'))).not.toThrow()
  })
})
