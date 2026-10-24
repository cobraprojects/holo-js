import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isInRealtimeDefinitionDirectory, resolveRealtimeDefinitionDirectories } from '../src/realtime-directories'

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
})
