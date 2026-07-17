import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoloStorageRuntimeConfig } from '@holo-js/storage'

type StoredValue = string | Uint8Array | ArrayBuffer | Buffer

function createBackend() {
  const values = new Map<string, StoredValue>()

  return {
    getItem: vi.fn(async <T>(key: string) => values.get(key) as T ?? null),
    getItemRaw: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      values.set(key, String(value))
    }),
    setItemRaw: vi.fn(async (key: string, value: StoredValue) => {
      values.set(key, value)
    }),
    hasItem: vi.fn(async (key: string) => values.has(key)),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    getKeys: vi.fn(async (base = '') => Array.from(values.keys()).filter(key => key.startsWith(base))),
  }
}

describe('storage runtime plugin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('configures storage runtime bindings from Nitro imports', async () => {
    const runtimeConfig: { holoStorage: HoloStorageRuntimeConfig, holo: { appUrl: string } } = {
      holoStorage: {
        defaultDisk: 'public',
        diskNames: ['public'],
        routePrefix: '/storage',
        disks: {
          public: {
            name: 'public',
            driver: 'public',
            visibility: 'public',
            root: './storage/app/public',
          },
        },
      },
      holo: {
        appUrl: 'https://app.test',
      },
    }
    const backend = createBackend()
    const useRuntimeConfig = vi.fn(() => runtimeConfig)
    const useNitroStorage = vi.fn(() => backend)

    vi.doMock('nitropack/runtime/plugin', () => ({
      defineNitroPlugin: (plugin: unknown) => plugin,
    }))
    vi.doMock('nitropack/runtime/config', () => ({
      useRuntimeConfig,
    }))
    vi.doMock('nitropack/runtime/storage', () => ({
      useStorage: useNitroStorage,
    }))

    const { resetStorageRuntime, useStorage } = await import('@holo-js/storage/runtime')
    resetStorageRuntime()

    const { default: initPlugin } = await import('../src/runtime/plugins/storage')
    ;(initPlugin as () => void)()

    const disk = useStorage('public')
    await expect(disk.exists('avatars/user-1.png')).resolves.toBe(false)
    expect(disk.url('avatars/user-1.png')).toBe('https://app.test/storage/avatars/user-1.png')
    expect(useRuntimeConfig).toHaveBeenCalled()
    expect(useNitroStorage).toHaveBeenCalledWith('holo:public')
  })

  it('re-exports the shared s3 runtime driver', async () => {
    const { default: adapterDriver } = await import('../src/runtime/drivers/s3')
    const { default: storageDriver } = await import('@holo-js/storage-s3')

    expect(adapterDriver).toBe(storageDriver)
  })
})

describe('forms runtime plugin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  type PlainHeaders = Record<string, number | string | string[] | undefined>

  function createFormHooks() {
    return {
      beforeResponse: undefined as ((event: unknown, response: unknown) => void) | undefined,
      renderResponse: undefined as ((response: unknown, context: unknown) => void) | undefined,
      hook(name: string, handler: (first: unknown, second: unknown) => void) {
        if (name === 'beforeResponse') {
          this.beforeResponse = handler
          return
        }

        if (name === 'render:response') {
          this.renderResponse = handler
        }
      },
    }
  }

  async function loadFormsPlugin(hooks = createFormHooks()) {
    vi.doMock('nitropack/runtime/plugin', () => ({
      defineNitroPlugin: (plugin: unknown) => plugin,
    }))

    const { default: formsPlugin } = await import('../src/runtime/plugins/forms')
    ;(formsPlugin as (nitroApp: { hooks: typeof hooks }) => void)({ hooks })
    return hooks
  }

  it('redirects browser form failures back with a flashed payload instead of raw JSON', async () => {
    const hooks = await loadFormsPlugin()

    const response = {
      statusCode: 422,
      headers: {
        'content-type': 'application/json',
      } as PlainHeaders,
      body: {
        ok: false,
        status: 422,
        valid: false,
        values: {
          title: 'Draft',
        },
        errors: {
          image: ['The selected file must be 2 MB or smaller.'],
        },
      },
    }

    hooks.beforeResponse?.({
      path: '/admin/posts/2/update',
      node: {
        req: {
          method: 'POST',
          url: '/admin/posts/2/update',
          headers: {
            accept: 'text/html,application/xhtml+xml',
            host: 'localhost:3000',
            referer: 'http://localhost:3000/admin/posts/2/edit',
          },
        },
      },
    }, response)

    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/admin/posts/2/edit')
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(response.headers['set-cookie']).toContain('holo_form_failure=')
    expect(response.body).toBe('')
  })

  it('redirects serialized browser form failures back with a flashed payload', async () => {
    const hooks = await loadFormsPlugin()

    const response = {
      statusCode: 422,
      headers: {} as PlainHeaders,
      body: JSON.stringify({
        ok: false,
        status: 422,
        valid: false,
        errors: {
          image: ['The selected file must be 2 MB or smaller.'],
        },
      }),
    }

    hooks.beforeResponse?.({
      path: '/admin/posts/create',
      node: {
        req: {
          method: 'POST',
          url: '/admin/posts/create',
          headers: {
            accept: 'text/html',
            host: 'localhost:3000',
            referer: 'http://localhost:3000/admin/posts/new',
          },
        },
      },
    }, response)

    expect(response.statusCode).toBe(303)
    expect(response.headers.location).toBe('/admin/posts/new')
    expect(response.headers['set-cookie']).toContain('holo_form_failure=')
    expect(response.body).toBe('')
  })

  it('redirects to the request path when referer is malformed or cross-origin', async () => {
    const hooks = await loadFormsPlugin()

    for (const referer of ['%%%bad-url', 'https://evil.test/admin/posts/new']) {
      const response = {
        statusCode: 422,
        headers: {} as PlainHeaders,
        body: {
          ok: false,
          status: 422,
          valid: false,
          errors: {
            image: ['The selected file must be 2 MB or smaller.'],
          },
        },
      }

      hooks.beforeResponse?.({
        path: '/admin/posts/create',
        node: {
          req: {
            method: 'POST',
            url: '/admin/posts/create',
            headers: {
              accept: ['text/html'],
              host: 'localhost:3000',
              referer,
            },
          },
        },
      }, response)

      expect(response.headers.location).toBe('/admin/posts/create')
      expect(response.statusCode).toBe(303)
    }
  })

  it('appends flashed payload cookies to existing response cookies', async () => {
    const hooks = await loadFormsPlugin()
    const setHeaders: Record<string, unknown> = {
      'set-cookie': ['session=abc; Path=/'],
    }
    const response = {
      statusCode: 422,
      headers: new Headers({
        'set-cookie': 'theme=dark; Path=/',
      }),
      body: {
        ok: false,
        status: 422,
        valid: false,
        errors: {
          image: ['The selected file must be 2 MB or smaller.'],
        },
      },
    }

    hooks.beforeResponse?.({
      node: {
        req: {
          method: 'POST',
          url: '/admin/posts/create',
          headers: {
            accept: 'text/html',
            host: 'localhost:3000',
          },
        },
        res: {
          getHeader(name: string) {
            return setHeaders[name]
          },
          setHeader(name: string, value: unknown) {
            setHeaders[name] = value
          },
        },
      },
    }, response)

    expect(setHeaders['set-cookie']).toEqual([
      'session=abc; Path=/',
      expect.stringContaining('holo_form_failure='),
    ])
    expect(response.headers.get('set-cookie')).toContain('theme=dark; Path=/')
    expect(response.headers.get('set-cookie')).toContain('holo_form_failure=')

    const plainHeadersResponse = {
      statusCode: 422,
      headers: {
        'set-cookie': ['theme=light; Path=/'],
      },
      body: {
        ok: false,
        status: 422,
        valid: false,
        errors: {
          image: ['The selected file must be 2 MB or smaller.'],
        },
      },
    }

    hooks.beforeResponse?.({
      node: {
        req: {
          method: 'POST',
          headers: {
            accept: 'text/html',
          },
        },
      },
    }, plainHeadersResponse)

    expect(plainHeadersResponse.headers['set-cookie']).toEqual([
      'theme=light; Path=/',
      expect.stringContaining('holo_form_failure='),
    ])

    const nodeHeaderResponse = {
      statusCode: 422,
      headers: {},
      body: {
        ok: false,
        status: 422,
        valid: false,
        errors: {
          image: ['The selected file must be 2 MB or smaller.'],
        },
      },
    }
    const nodeHeaders: Record<string, unknown> = {
      'set-cookie': 'session=abc; Path=/',
    }

    hooks.beforeResponse?.({
      node: {
        req: {
          method: 'POST',
          headers: {
            accept: 'text/html',
          },
        },
        res: {
          getHeader(name: string) {
            return nodeHeaders[name]
          },
          setHeader(name: string, value: unknown) {
            nodeHeaders[name] = value
          },
        },
      },
    }, nodeHeaderResponse)

    expect(nodeHeaders['set-cookie']).toEqual([
      'session=abc; Path=/',
      expect.stringContaining('holo_form_failure='),
    ])
  })

  it('ignores non-browser or invalid form failure responses', async () => {
    const hooks = await loadFormsPlugin()
    const responses = [
      {
        statusCode: 422,
        body: {
          ok: false,
          status: 422,
          valid: false,
          errors: {
            image: ['The selected file must be 2 MB or smaller.'],
          },
        },
        event: {
          node: {
            req: {
              method: 'GET',
              headers: {
                accept: 'text/html',
              },
            },
          },
        },
      },
      {
        statusCode: 422,
        body: '{',
        event: {
          node: {
            req: {
              method: 'POST',
              headers: {
                accept: 'text/html',
              },
            },
          },
        },
      },
      {
        statusCode: 422,
        body: JSON.stringify({
          ok: false,
          status: 422,
          valid: true,
          errors: {
            image: ['The selected file must be 2 MB or smaller.'],
          },
        }),
        event: {
          node: {
            req: {
              method: 'POST',
              headers: {
                accept: 'text/html',
              },
            },
          },
        },
      },
      {
        statusCode: 422,
        body: {
          ok: false,
          status: '422',
          valid: false,
          errors: {
            image: ['The selected file must be 2 MB or smaller.'],
          },
        },
        event: {
          node: {
            req: {
              method: 'POST',
              headers: {
                accept: 'text/html',
              },
            },
          },
        },
      },
      {
        statusCode: 422,
        body: {
          ok: false,
          status: 422,
          valid: false,
          errors: {
            image: ['The selected file must be 2 MB or smaller.'],
          },
        },
        event: {
          node: {
            req: {
              method: 'POST',
              headers: {
                accept: 'application/json',
              },
            },
          },
        },
      },
    ]

    for (const scenario of responses) {
      const response = {
        statusCode: scenario.statusCode,
        headers: {},
        body: scenario.body,
      }

      hooks.beforeResponse?.(scenario.event, response)

      expect(response.statusCode).toBe(422)
      expect(response.body).toBe(scenario.body)
      expect(response.headers).toEqual({})
    }
  })

  it('does not render flashed form failures into page HTML', async () => {
    const hooks = await loadFormsPlugin()

    expect(hooks.renderResponse).toBeUndefined()
  })

  it('leaves API form failures as JSON payloads', async () => {
    const hooks = await loadFormsPlugin()

    const response = {
      statusCode: 422,
      headers: {
        'content-type': 'application/json',
      },
      body: {
        ok: false,
        status: 422,
        valid: false,
        errors: {
          email: ['This field is required.'],
        },
      },
    }

    hooks.beforeResponse?.({
      path: '/api/login',
      node: {
        req: {
          method: 'POST',
          url: '/api/login',
          headers: {
            accept: 'text/html',
            host: 'localhost:3000',
          },
        },
      },
    }, response)

    expect(response.statusCode).toBe(422)
    expect(response.body).toEqual({
      ok: false,
      status: 422,
      valid: false,
      errors: {
        email: ['This field is required.'],
      },
    })
  })
})
