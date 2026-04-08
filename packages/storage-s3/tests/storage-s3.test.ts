import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createS3Driver from '../src'

describe('@holo-js/storage-s3', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('signs requests for object uploads', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const driver = createS3Driver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await driver.setItemRaw('reports:daily.txt', new TextEncoder().encode('ok'))

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    const request = firstCall?.[0] as unknown as Request
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
    expect(request.url).toContain('/reports/daily.txt')
  })
})
