import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPublicStorageResponse, normalizeModuleOptions, type NormalizedHoloStorageConfig } from '../src'
import { createTemporaryLocalStorageUrl } from '../src/temporaryLocalStorage'

const appKey = 'private-local-storage-test-key'
const roots = new Set<string>()

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'holo-temporary-storage-'))
  roots.add(root)
  await mkdir(join(root, 'private'), { recursive: true })
  await mkdir(join(root, 'other'), { recursive: true })
  await writeFile(join(root, 'private', 'image #1.png'), 'private-image')
  await writeFile(join(root, 'private', 'other.png'), 'other-image')
  await writeFile(join(root, 'other', 'image #1.png'), 'other-disk')
  const config: NormalizedHoloStorageConfig = {
    defaultDisk: 'local',
    routePrefix: '/assets',
    disks: {
      local: { driver: 'local', visibility: 'private', root: 'private' },
      other: { driver: 'local', visibility: 'private', root: 'other' },
    },
  }
  const runtime = normalizeModuleOptions(config)
  const disk = runtime.disks.local!
  const url = createTemporaryLocalStorageUrl(disk, 'image #1.png', { ...runtime, appKey, appUrl: 'https://app.test' }, 60)
  const response = (value = url, method = 'GET', key = appKey) => createPublicStorageResponse(root, config, new Request(value, { method }), key)
  return { root, config, runtime, disk, url, response }
}

afterEach(async () => {
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('private local storage URLs', () => {
  it('verifies the incoming HTTP authority when the framework uses an internal request hostname', async () => {
    const { root, config, url } = await fixture()
    const internal = new URL(url)
    internal.host = 'internal.test'
    const response = await createPublicStorageResponse(root, config, new Request(internal, { headers: { host: 'app.test' } }), appKey)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('private-image')
    for (const host of ['other-app.test', 'app.test/file', 'user@app.test']) {
      const rejected = await createPublicStorageResponse(root, config, new Request(url, { headers: { host } }), appKey)
      expect(rejected.status).toBe(404)
    }
  })

  it('serves only the signed private file with fresh private response headers', async () => {
    const { url, response } = await fixture()
    const result = await response()
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.headers.get('content-type')).toBe('image/png')
    await expect(result.text()).resolves.toBe('private-image')
    const head = await response(url, 'HEAD')
    expect(head.status).toBe(200)
    await expect(head.text()).resolves.toBe('')
    expect((await response(url, 'POST')).status).toBe(404)
    expect((await response(url, 'GET', 'different-app-key')).status).toBe(404)
  })

  it('rejects unsigned requests and changes to the file, disk, expiry or signature', async () => {
    const { url, response } = await fixture()
    const original = new URL(url)
    const mutations = [
      (value: URL) => { value.search = '' },
      (value: URL) => { value.host = 'other-app.test' },
      (value: URL) => { value.pathname = value.pathname.replace('image%20%231.png', 'other.png') },
      (value: URL) => { value.pathname = value.pathname.replace('/local/', '/other/') },
      (value: URL) => { value.searchParams.set('expires', String(Number(value.searchParams.get('expires')) + 60)) },
      (value: URL) => { value.searchParams.set('signature', '0'.repeat(64)) },
      (value: URL) => { value.searchParams.append('expires', value.searchParams.get('expires')!) },
      (value: URL) => { value.searchParams.set('download', '1') },
    ]
    for (const mutate of mutations) {
      const changed = new URL(original)
      mutate(changed)
      expect((await response(changed.toString())).status).toBe(404)
    }
    expect((await response('https://app.test/assets/__holo/local/image%20%231.png')).status).toBe(404)
  })

  it('rejects genuinely expired signatures and paths outside the configured root', async () => {
    const { root, runtime, disk, response } = await fixture()
    const signingConfig = { ...runtime, appKey, appUrl: 'https://app.test' }
    const expired = createTemporaryLocalStorageUrl(disk, 'image #1.png', signingConfig, -1)
    expect((await response(expired)).status).toBe(404)
    await writeFile(join(root, 'secret.txt'), 'secret')
    await symlink(join(root, 'secret.txt'), join(root, 'private', 'escape.txt'))
    const escape = createTemporaryLocalStorageUrl(disk, 'escape.txt', signingConfig, 60)
    expect((await response(escape)).status).toBe(404)
    for (const path of ['../secret.txt', 'nested/../../secret.txt', '.', 'nested/../image.png', 'nested\\image.png', 'image\u0000.png']) {
      expect(() => createTemporaryLocalStorageUrl(disk, path, signingConfig, 60)).toThrow('Invalid temporary local storage path')
    }
  })

  it('downloads active content without exposing it as an executable image', async () => {
    const { root, runtime, disk, response } = await fixture()
    await writeFile(join(root, 'private', 'image.svg'), '<svg><script>alert(1)</script></svg>')
    const url = createTemporaryLocalStorageUrl(disk, 'image.svg', { ...runtime, appKey, appUrl: 'https://app.test' }, 60)
    const result = await response(url)
    expect(result.headers.get('content-type')).toBe('application/octet-stream')
    expect(result.headers.get('content-disposition')).toBe('attachment')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
