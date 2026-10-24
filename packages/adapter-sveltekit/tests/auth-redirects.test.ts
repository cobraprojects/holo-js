import { isRedirect } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import { adapterSvelteKitInternals } from '../src'

async function caughtRedirect(url: string, status: 303 | 307): Promise<unknown> {
  const { redirectResponse } = adapterSvelteKitInternals.resolveSvelteKitAuthRequestAccessors()
  try {
    await redirectResponse?.(url, status)
  } catch (error) {
    return error
  }

  return undefined
}

describe('SvelteKit auth redirects', () => {
  it('redirects to an external provider URL', async () => {
    const error = await caughtRedirect('https://example.accounts.dev/handshake?x=1', 307)

    expect(isRedirect(error)).toBe(true)
    expect(error).toMatchObject({ status: 307, location: 'https://example.accounts.dev/handshake?x=1' })
  })

  it('keeps same-app redirects working', async () => {
    const error = await caughtRedirect('/login', 303)

    expect(isRedirect(error)).toBe(true)
    expect(error).toMatchObject({ status: 303, location: '/login' })
  })
})
