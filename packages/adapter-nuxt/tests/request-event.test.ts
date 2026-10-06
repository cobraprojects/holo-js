import { createApp, defineEventHandler, setHeader, toWebHandler } from 'h3'
import { describe, expect, it } from 'vitest'
import { createNuxtAuthRequestAccessors } from '../src/runtime/composables'

describe('explicit Nuxt authentication events', () => {
  it('reads request headers and cookies and appends response cookies without ambient Nitro context', async () => {
    const app = createApp()
    app.use(defineEventHandler(async event => {
      const accessors = createNuxtAuthRequestAccessors(event)
      expect(await accessors.getHeader('x-request-id')).toBe('request-1')
      expect(await accessors.getCookie('session')).toBe('stored session')
      setHeader(event, 'set-cookie', 'existing=preserved; Path=/')
      await accessors.appendResponseCookie?.('session=rotated; Path=/; HttpOnly')
      return 'Authenticated'
    }))
    const response = await toWebHandler(app)(new Request('https://example.test/admin', {
      headers: { cookie: 'session=stored%20session', 'x-request-id': 'request-1' },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.getSetCookie()).toEqual(['existing=preserved; Path=/', 'session=rotated; Path=/; HttpOnly'])
    await expect(response.text()).resolves.toBe('Authenticated')
  })

  it('redirects through the supplied native H3 response', async () => {
    const app = createApp()
    app.use(defineEventHandler(async event => {
      await createNuxtAuthRequestAccessors(event).redirectResponse?.('/signed-in', 303)
    }))
    const response = await toWebHandler(app)(new Request('https://example.test/login'))
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/signed-in')
  })
})
