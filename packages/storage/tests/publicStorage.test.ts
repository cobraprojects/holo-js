import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedHoloStorageConfig } from '../src/config'
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

  it('serves active public file types as downloads', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await writeFile(join(publicRoot, 'asset.svg'), '<svg><script>alert(1)</script></svg>')

    const response = await createPublicStorageResponse(
      projectRoot,
      storageConfig('./storage/app/public'),
      new Request('https://app.test/storage/asset.svg'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
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

  it('serves passive content types and downloads every active content type', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const contentTypes = {
      avif: 'image/avif',
      css: 'text/css; charset=utf-8',
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      json: 'application/json; charset=utf-8',
      mp3: 'audio/mpeg',
      pdf: 'application/pdf',
      png: 'image/png',
      txt: 'text/plain; charset=utf-8',
      webp: 'image/webp',
      woff: 'font/woff',
      woff2: 'font/woff2',
      bin: 'application/octet-stream',
    } as const

    for (const [extension, contentType] of Object.entries(contentTypes)) {
      await writeFile(join(publicRoot, `asset.${extension}`), 'content')
      const response = await createPublicStorageResponse(
        projectRoot,
        storageConfig('./storage/app/public'),
        new Request(`https://app.test/storage/asset.${extension}`),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(contentType)
    }

    for (const extension of ['html', 'js', 'mjs', 'svg']) {
      await writeFile(join(publicRoot, `active.${extension}`), 'active')
      const response = await createPublicStorageResponse(
        projectRoot,
        storageConfig('./storage/app/public'),
        new Request(`https://app.test/storage/active.${extension}`),
      )
      expect(response.headers.get('content-disposition')).toBe('attachment')
    }
  })

  it('rejects malformed, empty, traversal, escaping, and unavailable routes', async () => {
    const { projectRoot } = await createProject()
    const config = storageConfig('./storage/app/public')
    const paths = [
      '/storage',
      '/storage/%2e%2e/secret.txt',
      '/storage/%2Fetc/passwd',
      '/storage/%E0%A4%A',
      '/storage/missing.txt',
    ]

    for (const path of paths) {
      const response = await createPublicStorageResponse(
        projectRoot,
        config,
        new Request(`https://app.test${path}`),
      )
      expect(response.status).toBe(404)
    }

    const withoutPublicDisk: NormalizedHoloStorageConfig = {
      defaultDisk: 'private',
      routePrefix: '/storage',
      disks: {
        private: {
          driver: 'local',
          root: './storage/app/private',
          visibility: 'private',
        },
      },
    }
    const response = await createPublicStorageResponse(
      projectRoot,
      withoutPublicDisk,
      new Request('https://app.test/storage/missing.txt'),
    )
    expect(response.status).toBe(404)
  })

  it('serves named public disks through direct, reserved, and fallback routes', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const mediaRoot = join(projectRoot, 'storage/app/media')
    await mkdir(mediaRoot, { recursive: true })
    await writeFile(join(mediaRoot, 'photo.png'), 'photo')
    await mkdir(join(publicRoot, '__holo/unknown'), { recursive: true })
    await writeFile(join(publicRoot, '__holo/unknown/fallback.txt'), 'fallback')

    const config: NormalizedHoloStorageConfig = {
      defaultDisk: 'public',
      routePrefix: '/storage',
      disks: {
        public: {
          driver: 'public',
          root: './storage/app/public',
          visibility: 'public',
        },
        media: {
          driver: 'public',
          root: './storage/app/media',
          visibility: 'public',
        },
        remote: {
          driver: 's3',
          bucket: 'media',
          region: 'us-east-1',
          visibility: 'public',
        },
      },
    }

    for (const path of ['/storage/media/photo.png', '/storage/__holo/media/photo.png']) {
      const response = await createPublicStorageResponse(projectRoot, config, new Request(`https://app.test${path}`))
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('photo')
    }

    const fallback = await createPublicStorageResponse(
      projectRoot,
      config,
      new Request('https://app.test/storage/__holo/unknown/fallback.txt'),
    )
    expect(fallback.status).toBe(200)
    await expect(fallback.text()).resolves.toBe('fallback')

    const missingDiskFile = await createPublicStorageResponse(
      projectRoot,
      config,
      new Request('https://app.test/storage/__holo/media'),
    )
    expect(missingDiskFile.status).toBe(404)

    for (const path of ['/storage/media/%2Fetc/passwd', '/storage/media/missing.png']) {
      const response = await createPublicStorageResponse(projectRoot, config, new Request(`https://app.test${path}`))
      expect(response.status).toBe(404)
    }
  })
})
