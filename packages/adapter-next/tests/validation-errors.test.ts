import 'next/dist/server/node-environment'
import { resolve } from 'node:path'
import { createElement, memo, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { actionAsyncStorage } from 'next/dist/server/app-render/action-async-storage.external.js'
import { workAsyncStorage, type WorkStore } from 'next/dist/server/app-render/work-async-storage.external.js'
import { workUnitAsyncStorage, type WorkUnitStore } from 'next/dist/server/app-render/work-unit-async-storage.external.js'
import { LayoutRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import { ServerInsertedHTMLContext } from 'next/dist/shared/lib/server-inserted-html.shared-runtime'
import { RequestCookies } from 'next/dist/server/web/spec-extension/cookies'
import { MutableRequestCookiesAdapter } from 'next/dist/server/web/spec-extension/adapters/request-cookies'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { requestUrlInternals } from '@holo-js/kernel'
import { field, schema, validate, type ValidationErrorBag } from '@holo-js/validation'
import { useValidationErrors } from '../src/client'
import { adapterNextValidationErrorsInternals } from '../src/use-validation-errors'
import { adapterNextRuntimeInternals } from '../src/runtime'

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

const scriptMessageForm = schema({ title: field.string().required('</script><b>Title is required') })

const saveWithScriptMessage = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async () => {
  await validate({}, scriptMessageForm)
}), '$$id', { value: actionId })

const changePassword = Object.defineProperty(adapterNextRuntimeInternals.serverAction(async () => {
  await validate({ title: 'x', password: 'short' }, postForm, { bag: 'password' })
}), '$$id', { value: actionId })

type CookieJar = { readonly receive: (setCookies: readonly string[]) => void, readonly header: () => string }

// Loads a page: installs the browser's cookies and starts the hook's document.
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
  adapterNextValidationErrorsInternals.startDocument()
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

// Browsers with the Navigation API; install before installBrowserCookies(), which loads the page.
function installNavigationEvents(pathname: string): (pathname: string) => void {
  const listeners: Array<(event: { destination: { url: string } }) => void> = []
  const location = { pathname, protocol: 'http:' }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location })
  Object.defineProperty(globalThis, 'navigation', { configurable: true, value: { addEventListener: (_type: 'navigate', listener: (typeof listeners)[number]) => listeners.push(listener) } })
  onTestFinished(() => {
    Reflect.deleteProperty(globalThis, 'location')
    Reflect.deleteProperty(globalThis, 'navigation')
  })
  return (next) => {
    for (const listener of listeners) listener({ destination: { url: `http://blog.test${next}` } })
    location.pathname = next
  }
}

async function openPage(pathname: string, bag?: string) {
  let errors: ValidationErrorBag<Record<string, unknown>> | undefined
  let renderer!: ReactTestRenderer
  let currentPath = pathname
  // Memoized like a component whose props don't change, so only the router refresh rerenders it.
  const Page = memo(function Page() {
    errors = useValidationErrors(bag)
    return null
  })
  // Next gives the layout router context a new value on every refresh.
  const tree = () => createElement(PathnameContext.Provider, { value: currentPath }, createElement(LayoutRouterContext.Provider, { value: { url: currentPath } as never }, createElement(Page)))
  await act(async () => {
    renderer = create(tree())
  })
  let mounted = true
  onTestFinished(async () => {
    if (!mounted) return
    await act(async () => renderer.unmount())
    // Leaving the page resets the document's errors on the next task.
    await new Promise(resolve => setTimeout(resolve))
  })
  return {
    get errors() {
      if (!errors) throw new Error('The page did not render')
      return errors
    },
    async refresh() {
      await act(async () => renderer.update(tree()))
    },
    async close() {
      mounted = false
      await act(async () => renderer.unmount())
      await new Promise(resolve => setTimeout(resolve))
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
    const sameForm = await openPage('/posts/new')

    const response = await submit(() => createPost({ title: '', password: 'next-password' }), { withJavaScript: true })
    browser.receive(response.setCookies)
    await page.refresh()

    expect(response.value).toMatchObject({ ok: false, status: 422 })
    expect(page.errors.first('title')).toEqual(expect.any(String))
    expect(page.errors.has('password')).toBe(false)
    expect(sameForm.errors.first('title')).toBe(page.errors.first('title'))
    expect(response.setCookies.join()).not.toContain('next-password')
  })

  it('ignores the errors of a form posted from another page', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts')

    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true, pathname: '/posts/new' })).setCookies)
    await page.refresh()

    expect(page.errors.flatten()).toEqual({})
  })

  it('renders the errors of a form posted without JavaScript in the same response', async () => {
    const response = await submit(() => createPost({ title: '', password: 'next-password' }), { withJavaScript: false, render: () => createElement(TitleError) })

    expect(response.value).toMatchObject({ ok: false, status: 422 })
    expect(response.html).toContain('This field is required.')
    expect(response.html).not.toContain('next-password')
  })

  it('writes the server-rendered errors into the page once, so hydration shows them too', async () => {
    const inserted: Array<() => ReactNode> = []
    const render = () => createElement(ServerInsertedHTMLContext.Provider, { value: (callback: () => ReactNode) => inserted.push(callback) }, createElement(TitleError), createElement(TitleError))

    await submit(saveWithScriptMessage, { withJavaScript: false, render })
    const html = renderToString(createElement('div', null, ...inserted.map(callback => callback())))

    expect(html.match(/id="__holo_validation_flash"/g)).toHaveLength(1)
    expect(html).not.toContain('</script><b>')
    expect(html).toContain('Title is required')
    const flash = JSON.parse(JSON.parse(/<script[^>]*>(.*)<\/script>/.exec(html)?.[1] ?? '""') as string) as { errors: Record<string, string[]> }
    expect(flash.errors.title).toEqual(['</script><b>Title is required'])
  })

  it('writes nothing into a page that no failed form posted to', async () => {
    const inserted: Array<() => ReactNode> = []
    const render = () => createElement(ServerInsertedHTMLContext.Provider, { value: (callback: () => ReactNode) => inserted.push(callback) }, createElement(TitleError))

    await submit(() => createPost({ title: 'Hello', password: 'next-password' }), { withJavaScript: false, render })

    expect(inserted.map(callback => callback()).filter(Boolean)).toEqual([])
  })

  it('shows the errors to a call that first mounts after the form was posted', async () => {
    const browser = installBrowserCookies()

    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    const page = await openPage('/posts/new')

    expect(page.errors.has('title')).toBe(true)
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

  it('drops errors shown before a reload and clears them on navigation', async () => {
    const browser = installBrowserCookies()
    const page = await openPage('/posts/new')
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await page.refresh()
    expect(page.errors.has('title')).toBe(true)
    await page.close()

    adapterNextValidationErrorsInternals.startDocument()
    const reloaded = await openPage('/posts/new')
    expect(reloaded.errors.flatten()).toEqual({})
    expect(browser.header()).toBe('')

    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await reloaded.refresh()
    expect(reloaded.errors.has('title')).toBe(true)

    await reloaded.navigate('/posts')
    await reloaded.navigate('/posts/new')
    expect(reloaded.errors.flatten()).toEqual({})
    expect(browser.header()).toBe('')
  })

  it('shows the errors to a hook loaded after the form was posted', async () => {
    const browser = installBrowserCookies()
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)

    adapterNextValidationErrorsInternals.startDocument()
    const page = await openPage('/posts/new')

    expect(page.errors.has('title')).toBe(true)
  })

  it('keeps the errors when every call unmounts without leaving the page', async () => {
    installNavigationEvents('/posts/new')
    const browser = installBrowserCookies()
    const summary = await openPage('/posts/new')
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await summary.refresh()
    await summary.close()

    const reopened = await openPage('/posts/new')

    expect(reopened.errors.has('title')).toBe(true)
  })

  it('drops the errors with the last call in browsers without navigation events', async () => {
    const browser = installBrowserCookies()
    const summary = await openPage('/posts/new')
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await summary.refresh()
    await summary.close()

    const reopened = await openPage('/posts/new')

    expect(reopened.errors.flatten()).toEqual({})
    expect(browser.header()).toBe('')
  })

  it('drops the errors of a page left while no call was mounted', async () => {
    const navigate = installNavigationEvents('/posts/new')
    const browser = installBrowserCookies()
    const summary = await openPage('/posts/new')
    browser.receive((await submit(() => createPost({ title: '' }), { withJavaScript: true })).setCookies)
    await summary.refresh()
    await summary.close()

    navigate('/posts/new')
    expect(browser.header()).not.toBe('')
    navigate('/posts')
    navigate('/posts/new')
    const reopened = await openPage('/posts/new')

    expect(reopened.errors.flatten()).toEqual({})
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
