import { afterEach, describe, expect, it } from 'vitest'
import { cookieEncryptionInternals } from '@holo-js/kernel'
import { field, schema } from '@holo-js/validation'
import { adapterSvelteKitInternals, runWithSvelteKitRequestEvent, readValidationFlash } from '../src'
import { svelteClientInternals } from '../src/client'

const flashCookieName = 'HOLO-SVELTEKIT-VALIDATION'
const appKey = 'flash-cookie-test-app-key'

const failure = {
  ok: false as const,
  status: 422,
  valid: false as const,
  message: 'Invalid input.',
  bag: 'default',
  values: { email: 'ava@example.com', password: 'hunter2' },
  errors: { email: ['Invalid email.'] },
}

type ProjectState = { project?: unknown }

function setAppKey(key: string | undefined): void {
  const state = adapterSvelteKitInternals.getState() as ProjectState
  state.project = key === undefined ? undefined : { config: { app: { key, debug: false } } }
}

function redirectFor(path = '/login') {
  return adapterSvelteKitInternals.createValidationActionRedirectResponse({
    url: new URL(`https://app.test${path}`),
  } as never, failure as never)
}

function flashValueFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.slice(`${flashCookieName}=`.length).split(';', 1)[0] ?? ''
}

function withDocumentCookie(cookie: string, run: () => void): void {
  const globalWithDocument = globalThis as { document?: unknown }
  const previous = globalWithDocument.document
  globalWithDocument.document = { cookie }
  try {
    run()
  } finally {
    globalWithDocument.document = previous
  }
}

afterEach(() => {
  setAppKey(undefined)
})

describe('validation flash cookie', () => {
  it('is HttpOnly, so scripts cannot read it', () => {
    setAppKey(appKey)

    const cookie = redirectFor().headers.get('set-cookie') ?? ''

    expect(cookie).toMatch(/; HttpOnly/)
  })

  it('is encrypted, so the submitted values never appear in plaintext', () => {
    setAppKey(appKey)

    const response = redirectFor()
    const cookie = response.headers.get('set-cookie') ?? ''

    expect(cookie).not.toContain('ava@example.com')
    expect(cookie).not.toContain('hunter2')
    expect(cookie).not.toContain('Invalid')
  })

  it('restores the payload it encrypted when the app key matches', () => {
    setAppKey(appKey)

    const restored = adapterSvelteKitInternals.readValidationFlashCookie(flashValueFrom(redirectFor()))

    expect(restored).toMatchObject({ status: 422, values: { email: 'ava@example.com' } })
  })

  it('discards a tampered flash cookie', () => {
    setAppKey(appKey)
    const value = flashValueFrom(redirectFor())
    const tampered = `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`

    expect(adapterSvelteKitInternals.readValidationFlashCookie(tampered)).toBeUndefined()
    expect(adapterSvelteKitInternals.readValidationFlashCookie('{"status":422}')).toBeUndefined()
  })

  it('discards a flash cookie written under a different app key', () => {
    setAppKey(appKey)
    const value = flashValueFrom(redirectFor())

    setAppKey('another-app-key')

    expect(adapterSvelteKitInternals.readValidationFlashCookie(value)).toBeUndefined()
  })

  it('writes no flash when the app key is missing, rather than a plaintext cookie', () => {
    setAppKey(undefined)

    expect(redirectFor().headers.get('set-cookie')).toBeNull()
  })

  it('decrypts the flash cookie with the same raw key the session cookies use, including surrounding whitespace', () => {
    setAppKey('  flash-test-key  ')
    const value = flashValueFrom(redirectFor())

    expect(cookieEncryptionInternals.decryptCookieValue(flashCookieName, value, '  flash-test-key  ')).toContain('ava@example.com')
    expect(cookieEncryptionInternals.decryptCookieValue(flashCookieName, value, 'flash-test-key')).toContain('ava@example.com')
  })

  it('writes no flash when the app key is whitespace only', () => {
    setAppKey('   ')

    expect(redirectFor().headers.get('set-cookie')).toBeNull()
  })

  it('does not read a flash from document.cookie in the browser', () => {
    const plaintext = encodeURIComponent(JSON.stringify({ ...failure, values: { email: 'ava@example.com' } }))
    const loginSchema = schema({ email: field.string().required() })

    withDocumentCookie(`${flashCookieName}=${plaintext}`, () => {
      expect(svelteClientInternals.takeFlashedValidationState(loginSchema)).toBeUndefined()
    })
  })

  it('restores flashed input in the browser from the page data the server passes through', () => {
    const loginSchema = schema({ email: field.string().required() })

    const restored = svelteClientInternals.takeFlashedValidationState(loginSchema, {
      holoValidationFlash: { ...failure, values: { email: 'ava@example.com' } },
    })

    expect(restored).toMatchObject({ values: { email: 'ava@example.com' } })
  })

  it('drops sensitive fields when restoring from page data', () => {
    const loginSchema = schema({
      email: field.string().required(),
      password: field.string().required().sensitive(),
    })

    const restored = svelteClientInternals.takeFlashedValidationState(loginSchema, {
      holoValidationFlash: { ...failure, values: { email: 'ava@example.com', password: 'hunter2' } },
    })

    expect(restored?.values).toEqual({ email: 'ava@example.com' })
  })

  it('does not hand a flash to a different page, and still consumes it', () => {
    setAppKey(appKey)
    const value = flashValueFrom(redirectFor('/admin/posts/new'))
    const deleted: string[] = []
    const event = {
      url: new URL('https://app.test/admin/posts/1/edit'),
      cookies: {
        get: (name: string) => (name === flashCookieName ? value : undefined),
        delete: (name: string) => deleted.push(name),
      },
    }

    const page = runWithSvelteKitRequestEvent(event as never, () => readValidationFlash(new URL('https://app.test/admin/posts/1/edit')))

    expect(page).toBeUndefined()
    expect(deleted).toEqual([flashCookieName])
  })

  it('does not restore a flash on a browser page other than the one it was written for', () => {
    const globalWithLocation = globalThis as { location?: { pathname: string } }
    const previous = globalWithLocation.location
    globalWithLocation.location = { pathname: '/admin/posts/1/edit' }
    try {
      const restored = svelteClientInternals.takeFlashedValidationState(schema({ email: field.string().required() }), {
        holoValidationFlash: { ...failure, path: '/admin/posts/new', values: { email: 'ava@example.com' } },
      })

      expect(restored).toBeUndefined()
    } finally {
      globalWithLocation.location = previous
    }
  })

  it('restores a flash on the browser page it was written for', () => {
    const globalWithLocation = globalThis as { location?: { pathname: string } }
    const previous = globalWithLocation.location
    globalWithLocation.location = { pathname: '/admin/posts/new' }
    try {
      const restored = svelteClientInternals.takeFlashedValidationState(schema({ email: field.string().required() }), {
        holoValidationFlash: { ...failure, path: '/admin/posts/new', values: { email: 'ava@example.com' } },
      })

      expect(restored).toMatchObject({ values: { email: 'ava@example.com' } })
    } finally {
      globalWithLocation.location = previous
    }
  })

  it('reads and clears the flash for the page load from the server event', () => {
    setAppKey(appKey)
    const value = flashValueFrom(redirectFor())
    const deleted: string[] = []
    const event = {
      url: new URL('https://app.test/login'),
      cookies: {
        get: (name: string) => (name === flashCookieName ? value : undefined),
        delete: (name: string) => deleted.push(name),
      },
    }

    const page = runWithSvelteKitRequestEvent(event as never, () => readValidationFlash())

    expect(page).toMatchObject({ status: 422, values: { email: 'ava@example.com' } })
    expect(deleted).toEqual([flashCookieName])
  })
})
