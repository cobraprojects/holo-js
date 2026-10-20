import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { createApp, toWebHandler } from 'h3'
import { requestUrlInternals } from '@holo-js/kernel'
import { resetHoloRuntime } from '@holo-js/core'
import { Storage } from '@holo-js/storage/runtime'
import { configureHoloRuntimeConfig, holo, resetHoloRuntimeConfig } from '../src/runtime/composables'
import storageHandler from '../src/runtime/server/routes/storage'
import { serve } from './support/http'
import { configureSecurityRuntime, resetSecurityRuntime } from '../../security/src'

const roots = new Set<string>()

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-storage-'))
  roots.add(root)
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/app.mjs'), `export default ${JSON.stringify({ url: 'https://app.test', key: 'native-nuxt-storage-test-signing-key' })}\n`)
  await writeFile(join(root, 'config/database.mjs'), `export default ${JSON.stringify({
    defaultConnection: 'default',
    connections: { default: { driver: 'sqlite', url: ':memory:' } },
  })}\n`)
  await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
    defaultDisk: 'local',
    routePrefix: '/storage',
    disks: {
      local: { driver: 'local', visibility: 'private', root: './runtime-private' },
      public: { driver: 'public', visibility: 'public', root: './runtime-public' },
      assets: { driver: 'public', visibility: 'public', root: './runtime-assets' },
    },
  })}\n`)
  configureHoloRuntimeConfig({ holo: { projectRoot: root } })
  const app = createApp()
  app.use(storageHandler)
  return { root, app, request: toWebHandler(app) }
}

function getRaw(base: string, target: string, headers: Record<string, string>): Promise<{ status: number, body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: target, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function trustProxies(trustedProxies: string[], peer: string): void {
  requestUrlInternals.provideConnectionAddress(() => peer)
  configureSecurityRuntime({ config: { trustedProxies } })
  onTestFinished(() => {
    resetSecurityRuntime()
    requestUrlInternals.provideConnectionAddress(undefined)
  })
}

afterEach(async () => {
  await resetHoloRuntime()
  resetHoloRuntimeConfig()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('native Nuxt storage route', () => {
  it('boots discovered public disks and forwards file, HEAD and missing-file responses through H3', async () => {
    const { root, request } = await project()
    await mkdir(join(root, 'runtime-public', 'assets'), { recursive: true })
    await mkdir(join(root, 'runtime-assets'), { recursive: true })
    await mkdir(join(root, 'runtime-private'), { recursive: true })
    await writeFile(join(root, 'runtime-public', 'assets', 'item.txt'), 'Default public file')
    await writeFile(join(root, 'runtime-assets', 'item.txt'), 'Named public file')
    await writeFile(join(root, 'runtime-public', 'download.svg'), '<svg></svg>')
    await writeFile(join(root, 'runtime-private', 'secret.txt'), 'Private file')
    await symlink(join(root, 'runtime-private', 'secret.txt'), join(root, 'runtime-public', 'escape.txt'))
    const response = await request(new Request('https://app.test/storage/assets/item.txt'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('Default public file')))
    await expect(response.text()).resolves.toBe('Default public file')
    const named = await request(new Request('https://app.test/storage/__holo/assets/item.txt'))
    await expect(named.text()).resolves.toBe('Named public file')
    const head = await request(new Request('https://app.test/storage/assets/item.txt', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
    await expect(head.text()).resolves.toBe('')
    const download = await request(new Request('https://app.test/storage/download.svg'))
    expect(download.headers.get('content-disposition')).toBe('attachment')
    expect(download.headers.get('content-type')).toBe('application/octet-stream')
    for (const path of ['escape.txt', '__holo/local/secret.txt', 'missing.txt', '%2e%2e%2fsecret.txt']) {
      const missing = await request(new Request(`https://app.test/storage/${path}`))
      expect(missing.status).toBe(404)
      await expect(missing.text()).resolves.toBe('Storage file not found.')
    }
  })

  it('serves signed private files with native response headers and rejects unsigned access', async () => {
    const { request } = await project()
    await holo.getApp()
    await Storage.disk('local').put('attachment.txt', 'Private attachment')
    const url = Storage.disk('local').temporaryUrl('attachment.txt', { expiresIn: 60 })
    const response = await request(new Request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength('Private attachment')))
    await expect(response.text()).resolves.toBe('Private attachment')
    const head = await request(new Request(url, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
    await expect(head.text()).resolves.toBe('')
    const unsigned = new URL(url)
    unsigned.search = ''
    expect((await request(new Request(unsigned))).status).toBe(404)
  })
})

describe('native Nuxt storage route behind a proxy', () => {
  it('ignores X-Forwarded-Proto from a peer that is not a trusted proxy', async () => {
    const { app } = await project()
    await holo.getApp()
    await Storage.disk('local').put('attachment.txt', 'Private attachment')
    const target = new URL(Storage.disk('local').temporaryUrl('attachment.txt', { expiresIn: 60 }))
    const path = `${target.pathname}${target.search}`
    const base = await serve(app)
    const forwarded = { host: 'app.test', 'x-forwarded-proto': 'https' }

    trustProxies(['10.0.0.1'], '127.0.0.1')
    expect((await getRaw(base, path, forwarded)).status).toBe(404)
  })

  it('honors X-Forwarded-Proto from a trusted proxy', async () => {
    const { app } = await project()
    await holo.getApp()
    await Storage.disk('local').put('attachment.txt', 'Private attachment')
    const target = new URL(Storage.disk('local').temporaryUrl('attachment.txt', { expiresIn: 60 }))
    const path = `${target.pathname}${target.search}`
    const base = await serve(app)

    trustProxies(['127.0.0.1'], '127.0.0.1')
    const served = await getRaw(base, path, { host: 'app.test', 'x-forwarded-proto': 'https' })
    expect(served.status).toBe(200)
    expect(served.body).toBe('Private attachment')
  })
})
