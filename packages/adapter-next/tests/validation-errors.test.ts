import 'next/dist/server/node-environment'
import { resolve } from 'node:path'
import { createElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { actionAsyncStorage } from 'next/dist/server/app-render/action-async-storage.external.js'
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js'
import { workUnitAsyncStorage, type WorkUnitStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies'
import { MutableRequestCookiesAdapter } from 'next/dist/server/web/spec-extension/adapters/request-cookies'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { requestUrlInternals } from '@holo-js/kernel'
import { field, schema, validate, type ValidationErrorBag } from '@holo-js/validation'
import { useValidationErrors } from '../src/client'
import { adapterNextRuntimeInternals } from '../src/runtime'
import { HoloValidationErrorsProvider } from '../src/validation-errors'
import { adapterNextLayoutInternals } from '../src/validation-layout'

const actionId = `40${'c'.repeat(40)}`
const postForm = schema({ title: field.string().required(), password: field.password().required().min(12) })

const createPost = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async (input: Record<string, string>) => {
  await validate(input, postForm)
  return 'created'
}), '$$id', { value: actionId })

const manyFields = schema(Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`item_${index}_title`, field.string().required('This field is required for this item.').min(3, 'Use at least three characters.')])))

const saveItems = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async () => {
  await validate({}, manyFields)
}), '$$id', { value: actionId })

const profileForm = schema({ bio: field.string().required('x'.repeat(4000)), email: field.string().required('Email is required.') })

const saveProfile = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async () => {
  await validate({}, profileForm)
}), '$$id', { value: actionId })

const changePassword = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async () => {
  await validate({ title: 'x', password: 'short' }, postForm, { bag: 'password' })
}), '$$id', { value: actionId })

type CookieJar = { readonly receive: (setCookies: readonly string[]) => void, readonly header: () => string }

function installBrowserCookies(): CookieJar {
  const jar = new Map<string, string>()
  const write = (setCookie: string) => {
    const [pair = '', ...attributes] = setCookie.split(';').map(part => part.trim())
    const separator = pair.indexOf('=')
    const name = pair.slice(0, separator)
    const expired = attributes.some(attribute => /^max-age=0$/i.test(attribute)
      || (/^expires=/i.test(attribute) && Date.parse(attribute.slice('expires='.length)) <= Date.now()))
    if (expired) jar.delete(name)
    else jar.set(name, pair.slice(separator + 1))
  }
  const header = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { get cookie() { return header() }, set cookie(value: string) { write(value) } } })
  onTestFinished(() => {
    Reflect.deleteProperty(globalThis, 'document')
  })
  return { receive: setCookies => setCookies.forEach(write), header }
}

async function submit<TResult>(action: () => Promise<TResult>, request: { readonly cookie?: string, readonly withJavaScript: boolean, readonly pathname?: string, readonly protocol?: 'http' | 'https', readonly render?: () => ReactNode }) {
  const pathname = request.pathname ?? '/posts/new'
  const headers = new Headers({
    origin: 'https://blog.test',
    'x-forwarded-proto': request.protocol ?? 'http',
    ...(request.withJavaScript ? { 'next-action': actionId } : {}),
    ...(request.cookie ? { cookie: request.cookie } : {}),
  })
  let setCookies: readonly string[] = []
  const requestCookies = new RequestCookies(headers)
  const store = {
    type: 'request',
    phase: 'action',
    headers,
    url: { pathname, search: '' },
    cookies: requestCookies,
    userspaceMutableCookies: MutableRequestCookiesAdapter.wrap(requestCookies, (cookies) => {
      setCookies = cookies
    }),
  } as unknown as WorkUnitStore
  const result = await workAsyncStorage.run({ route: '/posts/new' } as WorkStore, () => actionAsyncStorage.run({ isAction: true }, () => workUnitAsyncStorage.run(store, async () => {
    const value = await action()
    return { value, html: request.render ? renderToString(createElement(PathnameContext.Provider, { value: pathname }, request.render())) : undefined }
  })))
  return { ...result, setCookies }
}

async function openPage(pathname: string, bag?: string, initial?: string) {
  let errors: ValidationErrorBag<Record<string, unknown>> | undefined
  let renderer!: ReactTestRenderer
  let currentPath = pathname
  function Page() {
    errors = useValidationErrors(bag)
    return null
  }
  const tree = () => createElement(PathnameContext.Provider, { value: currentPath }, createElement(HoloValidationErrorsProvider, { initial }, createElement(Page)))
  await act(async () => {
    renderer = create(tree())
  })
  onTestFinished(async () => {
    await act(async () => renderer.unmount())
  })
  return {
    get errors() {
      if (!errors) throw new Error('The page did not render')
      return errors
    },
    async refresh() {
      await act(async () => renderer.update(tree()))
    },
    async navigate(path: string) {
      currentPath = path
      await act(async () => renderer.update(tree()))
    },
  }
}

function TitleError() {
  const errors = useValidationErrors()
  return createElement('p', null, errors.first('title') ?? 'no errors')
}

beforeEach(() => {
  vi.spyOn(process, 'cwd').mockReturnValue(resolve(import.meta.dirname, '..'))
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  onTestFinished(() => {
    if (previous) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useValidationErrors() in Next', () => {
  it('shows the errors of a form action submitted with JavaScript on the page that posted it', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')
    const other = await openPage('/posts')

    const response = await submit(() => createPost({ title: '', password: 'next-password' }), { withJavaScript: true })
    browser.receive(response.setCookies)
    await page.refresh()
    await other.refresh()

    expect(response.value).toMatchObject({ ok: false, status: 422 })
    expect(page.errors.first('title')).toEqual(expect.any(String))
    expect(page.errors.has('password')).toBe(false)
    expect(other.errors.flatten()).toEqual({})
    expect(response.setCookies.join()).not.toContain('next-password')
  })

  it('renders the errors of a form posted without JavaScript in the same response', async () => {
    const WrappedLayout = adapterNextLayoutInternals.validationErrorsLayout(() => createElement(TitleError))

    const response = await submit(() => createPost({ title: '', password: 'next-password' }), { withJavaScript: false, render: () => createElement(WrappedLayout) })

    expect(response.value).toMatchObject({ ok: false, status: 422 })
    expect(response.html).toContain('This field is required.')
    expect(response.html).not.toContain('next-password')
  })

  it('reads only the requested error bag', async () => {
    const browser = installBrowserCookies()
    const defaultBag = await openPage('/posts/new')
    const passwordBag = await openPage('/posts/new', 'password')

    browser.receive((await submit(changePassword, { withJavaScript: true })).setCookies)
    await defaultBag.refresh()
    await passwordBag.refresh()

    expect(defaultBag.errors.flatten()).toEqual({})
    expect(passwordBag.errors.has('password')).toBe(true)
  })

  it('clears the errors when the next submission succeeds', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await page.refresh()
    expect(page.errors.has('title')).toBe(true)

    const success = await submit(() => createPost({ title: 'Hello', password: 'next-password' }), { withJavaScript: true, cookie: browser.header() })
    browser.receive(success.setCookies)
    await page.refresh()

    expect(success.value).toBe('created')
    expect(page.errors.flatten()).toEqual({})
  })

  it('drops errors left over from an earlier page load and clears them on navigation', async () => {
    const browser = installBrowserCookies()
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)

    const reloaded = await openPage('/posts/new')
    await reloaded.refresh()
    expect(reloaded.errors.flatten()).toEqual({})

    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await reloaded.refresh()
    expect(reloaded.errors.has('title')).toBe(true)

    await reloaded.navigate('/posts')
    await reloaded.navigate('/posts/new')
    expect(reloaded.errors.flatten()).toEqual({})
    expect(browser.header()).toBe('')
  })

  it('keeps the errors of a large form within the browser cookie limit', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')

    const response = await submit(saveItems, { withJavaScript: true })
    browser.receive(response.setCookies)
    await page.refresh()

    expect(response.setCookies.every(cookie => cookie.length < 4096)).toBe(true)
    expect(page.errors.first('item_0_title')).toBe('This field is required for this item.')
  })

  it('ignores a forged error cookie instead of failing to render', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')

    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    const [name, value] = browser.header().split('=') as [string, string]
    const forged = { ...JSON.parse(decodeURIComponent(value)) as object, errors: { '__proto__.polluted': ['forged'] } }
    browser.receive([`${name}=${encodeURIComponent(JSON.stringify(forged))}; Path=/`])
    await page.refresh()

    expect(page.errors.flatten()).toEqual({})
  })

  it('keeps the errors that fit when one message is too large for the browser cookie', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')

    browser.receive((await submit(saveProfile, { withJavaScript: true })).setCookies)
    await page.refresh()

    expect(page.errors.first('email')).toBe('Email is required.')
  })

  it('shows the errors of a page with a very long address', async () => {
    const browser = installBrowserCookies()
    const pathname = `/posts/${'a'.repeat(4050)}`
    const page = await openPage(pathname)

    const response = await submit(() => createPost({ title: '' }), { withJavaScript: true, pathname })
    browser.receive(response.setCookies)
    await page.refresh()

    expect(response.setCookies.every(cookie => cookie.length < 4096)).toBe(true)
    expect(page.errors.has('title')).toBe(true)
  })

  it('marks the error cookie Secure from the request scheme, not from the Origin header', async () => {
    const plain = await submit(() => createPost({ title: '' }), { withJavaScript: true })
    expect(plain.setCookies.join()).not.toMatch(/secure/i)

    const servedOverHttps = await submit(() => createPost({ title: '' }), { withJavaScript: true, protocol: 'https' })
    expect(servedOverHttps.setCookies.join()).toMatch(/secure/i)

    requestUrlInternals.configureForwardedRequestResolver(() => ({ protocol: 'https' }))
    onTestFinished(() => requestUrlInternals.configureForwardedRequestResolver(undefined))
    const behindHttpsProxy = await submit(() => createPost({ title: '' }), { withJavaScript: true })
    expect(behindHttpsProxy.setCookies.join()).toMatch(/secure/i)
  })
})
