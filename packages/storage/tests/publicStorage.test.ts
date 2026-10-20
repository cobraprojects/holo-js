import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestUrlInternals } from '@holo-js/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedHoloStorageConfig } from '../src/config'
import { createPublicStorageResponse, normalizeModuleOptions } from '../src'
import { createTemporaryLocalStorageUrl } from '../src/temporaryLocalStorage'

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

  it('serves encoded media with native byte ranges independent of its extension', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const contents = await readFile(new URL('../../kernel/tests/fixtures/mime/sample.wav', import.meta.url))
    await writeFile(join(publicRoot, 'audio.bin'), contents)
    const config = storageConfig('./storage/app/public')
    const url = 'https://app.test/storage/audio.bin'
    for (const [range, start, end] of [
      ['bytes=0-', 0, contents.length - 1],
      ['bytes=10-19', 10, 19],
      ['bytes=10-99999999999999999999', 10, contents.length - 1],
      ['bytes=-10', contents.length - 10, contents.length - 1],
      ['bytes=-99999999999999999999', 0, contents.length - 1],
    ] as const) {
      const response = await createPublicStorageResponse(projectRoot, config, new Request(url, { headers: { range } }))
      expect(response.status).toBe(206)
      expect(response.headers.get('content-type')).toBe('audio/wav')
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${contents.length}`)
      expect(response.headers.get('content-length')).toBe(String(end - start + 1))
      expect(Buffer.from(await response.arrayBuffer())).toEqual(contents.subarray(start, end + 1))
    }
    for (const range of ['bytes=99999999999999999999-', 'bytes=-0']) {
      const response = await createPublicStorageResponse(projectRoot, config, new Request(url, { headers: { range } }))
      expect(response.status).toBe(416)
      expect(response.headers.get('content-range')).toBe(`bytes */${contents.length}`)
      expect(response.headers.get('content-length')).toBe('0')
      await expect(response.text()).resolves.toBe('')
    }
    const ignoredRanges: HeadersInit[] = [{ range: 'bytes=4-2' }, { range: 'bytes=0-1,4-5' }, { range: 'items=0-1' }, { range: 'bytes=0-1', 'if-range': '"stale"' }]
    for (const headers of ignoredRanges) {
      const response = await createPublicStorageResponse(projectRoot, config, new Request(url, { headers }))
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(contents)
    }
    const head = await createPublicStorageResponse(projectRoot, config, new Request(url, { method: 'HEAD', headers: { range: 'bytes=0-1' } }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('audio/wav')
    expect(head.headers.get('content-length')).toBe(String(contents.length))
    expect(head.headers.get('content-range')).toBeNull()
    expect(head.body).toBeNull()
  })

  it('serves empty files without opening a response stream', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await writeFile(join(publicRoot, 'empty.bin'), '')
    const response = await createPublicStorageResponse(projectRoot, storageConfig('./storage/app/public'), new Request('https://app.test/storage/empty.bin', { headers: { range: 'bytes=0-' } }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('0')
    await expect(response.text()).resolves.toBe('')
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

  it('downloads script-capable content disguised behind a passive extension', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await writeFile(
      join(publicRoot, 'avatar.png'),
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
    )

    const response = await createPublicStorageResponse(
      projectRoot,
      storageConfig('./storage/app/public'),
      new Request('https://app.test/storage/avatar.png'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('returns public file information on HEAD without a response body and refuses other methods', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const contents = 'Stored file information'
    await writeFile(join(publicRoot, 'asset.txt'), contents)
    const config = storageConfig('./storage/app/public')
    const url = 'https://app.test/storage/asset.txt'
    const response = await createPublicStorageResponse(projectRoot, config, new Request(url, { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.body).toBeNull()
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(contents)))
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const get = await createPublicStorageResponse(projectRoot, config, new Request(url))
    expect(get.headers.get('content-length')).toBe(response.headers.get('content-length'))
    await expect(get.text()).resolves.toBe(contents)
    const rejected = await createPublicStorageResponse(projectRoot, config, new Request(url, { method: 'POST' }))
    expect(rejected.status).toBe(404)
    await expect(rejected.text()).resolves.toBe('Storage file not found.')
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

  it('serves text formats inline by name, binary formats only when their bytes match, and downloads the rest', async () => {
    const { projectRoot, publicRoot } = await createProject()
    const respond = (name: string) => createPublicStorageResponse(
      projectRoot,
      storageConfig('./storage/app/public'),
      new Request(`https://app.test/storage/${name}`),
    )
    const inline = {
      'asset.css': 'text/css; charset=utf-8',
      'asset.csv': 'text/csv; charset=utf-8',
      'asset.json': 'application/json; charset=utf-8',
      'asset.md': 'text/markdown; charset=utf-8',
      'asset.txt': 'text/plain; charset=utf-8',
    } as const
    for (const [name, contentType] of Object.entries(inline)) {
      await writeFile(join(publicRoot, name), 'content')
      const response = await respond(name)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(contentType)
      expect(response.headers.get('content-disposition')).toBeNull()
    }

    for (const name of ['forged.png', 'forged.pdf', 'forged.mp3', 'forged.woff2', 'asset.bin', 'active.html', 'active.js', 'active.mjs', 'active.svg', 'active.xml']) {
      await writeFile(join(publicRoot, name), 'content')
      const response = await respond(name)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('application/octet-stream')
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
      '/storage/%5Csecret.txt',
      '/storage/secret%00.txt',
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

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor) throw new Error('Missing platform descriptor')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

describe('public storage names on Windows', () => {
  afterEach(async () => {
    await Promise.all(Array.from(tempRoots, root => rm(root, { recursive: true, force: true })))
    tempRoots.clear()
  })

  it('serves a public disk whose name is not a Windows file name, and still refuses its sidecar aliases', async () => {
    const { projectRoot } = await createProject()
    const conRoot = join(projectRoot, 'storage/app/con-disk')
    await mkdir(conRoot, { recursive: true })
    await writeFile(join(conRoot, 'report.txt'), 'report')
    await writeFile(join(conRoot, 'report.txt$'), '{"owner":"ops"}')
    await writeFile(join(conRoot, 'report.txt$.'), 'metadata alias')
    const config: NormalizedHoloStorageConfig = {
      defaultDisk: 'CON',
      routePrefix: '/storage',
      disks: { CON: { driver: 'public', visibility: 'public', root: './storage/app/con-disk' } },
    }
    const runtime = normalizeModuleOptions(config)
    const appKey = 'windows-disk-name-test-key'
    const request = (url: string) => createPublicStorageResponse(projectRoot, config, new Request(url), appKey)

    await withPlatform('win32', async () => {
      const served = await request('https://app.test/storage/__holo/CON/report.txt')
      expect(served.status).toBe(200)
      await expect(served.text()).resolves.toBe('report')
      for (const path of ['report.txt%24', 'report.txt%24.', 'nul.txt']) {
        expect((await request(`https://app.test/storage/__holo/CON/${path}`)).status, path).toBe(404)
      }

      const temporary = createTemporaryLocalStorageUrl(runtime.disks.CON!, 'report.txt', { ...runtime, appKey, appUrl: 'https://app.test' }, 60)
      const signed = await request(temporary)
      expect(signed.status).toBe(200)
      await expect(signed.text()).resolves.toBe('report')
      expect(() => createTemporaryLocalStorageUrl(runtime.disks.CON!, 'report.txt$.', { ...runtime, appKey, appUrl: 'https://app.test' }, 60)).toThrow()
    })
  })

  it('refuses requests that Windows would resolve to a metadata sidecar or device, and still serves normal files', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await writeFile(join(publicRoot, 'report.txt'), 'report')
    await writeFile(join(publicRoot, 'report.txt$'), '{"owner":"ops"}')
    for (const alias of ['report.txt$.', 'report.txt$ ', 'nul.txt', 'CON', 'COM¹.txt', 'lpt³', 'Com² .log']) {
      await writeFile(join(publicRoot, alias), 'metadata alias')
    }
    const config = storageConfig('./storage/app/public')
    const request = (path: string) => createPublicStorageResponse(projectRoot, config, new Request(`https://app.test/storage/${path}`))

    await withPlatform('win32', async () => {
      for (const path of ['report.txt%24.', 'report.txt%24%20', 'nul.txt', 'CON', 'report.txt%24', encodeURIComponent('COM¹.txt'), encodeURIComponent('lpt³'), encodeURIComponent('Com² .log')]) {
        expect((await request(path)).status, path).toBe(404)
      }
      const served = await request('report.txt')
      expect(served.status).toBe(200)
      await expect(served.text()).resolves.toBe('report')
    })
  })
})

describe('createPublicStorageResponse behind a trusted proxy', () => {
  it('routes public files by the unprefixed path when a trusted proxy sends a forwarded prefix', async () => {
    const { projectRoot, publicRoot } = await createProject()
    await mkdir(join(publicRoot, 'assets'), { recursive: true })
    await writeFile(join(publicRoot, 'assets', 'item.txt'), 'Public file')
    requestUrlInternals.provideConnectionAddress(() => '10.0.0.1')
    requestUrlInternals.configureForwardedRequestResolver(readHeader => ({ prefix: readHeader('x-forwarded-prefix') }))
    try {
      const response = await createPublicStorageResponse(
        projectRoot,
        storageConfig(publicRoot),
        new Request('http://app.test/storage/assets/item.txt', { headers: { 'x-forwarded-prefix': '/blog' } }),
      )
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('Public file')
    } finally {
      requestUrlInternals.configureForwardedRequestResolver(undefined)
      requestUrlInternals.provideConnectionAddress(undefined)
    }
  })
})
