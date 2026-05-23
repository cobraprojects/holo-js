import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedHoloStorageConfig } from '@holo-js/config'
import { createPublicStorageResponse } from '../src'

const tempRoots = new Set<string>()

function storageConfig(root: string): NormalizedHoloStorageConfig {
  return {
    defaultDisk: 'public',
    routePrefix: '/storage',
    disks: {
      public: {
        driver: 'public',
        root,
        visibility: 'public',
      },
    },
  }
}

async function createProject(): Promise<{ projectRoot: string, publicRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-public-storage-'))
  tempRoots.add(projectRoot)
  const publicRoot = join(projectRoot, 'storage/app/public')
  await mkdir(publicRoot, { recursive: true })

  return { projectRoot, publicRoot }
}

describe('createPublicStorageResponse', () => {
  afterEach(async () => {
    await Promise.all(Array.from(tempRoots, root => rm(root, { recursive: true, force: true })))
    tempRoots.clear()
  })

  it('serves public symlinks through their resolved in-root target', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await writeFile(join(publicRoot, 'target.json'), '{"ok":true}')
    await symlink(join(publicRoot, 'target.json'), join(publicRoot, 'asset.txt'))

    const response = await createPublicStorageResponse(
      projectRoot,
      storageConfig('./storage/app/public'),
      new Request('https://app.test/storage/asset.txt'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    await expect(response.text()).resolves.toBe('{"ok":true}')
  })

  it('does not read public symlinks that resolve outside the disk root', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const secretPath = join(projectRoot, 'secret.txt')
    await writeFile(secretPath, 'secret')
    await symlink(secretPath, join(publicRoot, 'secret.txt'))

    const response = await createPublicStorageResponse(
      projectRoot,
      storageConfig('./storage/app/public'),
      new Request('https://app.test/storage/secret.txt'),
    )

    expect(response.status).toBe(404)
    await expect(response.text()).resolves.toBe('Storage file not found.')
  })
})
