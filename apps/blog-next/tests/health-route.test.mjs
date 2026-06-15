import { describe, expect, it } from 'vitest'

const healthRoute = await import('../app/api/holo/health/route.ts')

describe('blog-next health route', () => {
  it('returns the app health contract', async () => {
    const response = await healthRoute.GET()
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toEqual({
      ok: true,
      framework: 'next',
    })
  })
})
