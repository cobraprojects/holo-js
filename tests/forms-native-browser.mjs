import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { configureSecurityRuntime, csrf, cors, defineSecurityConfig, resetSecurityRuntime } from '../packages/security/dist/index.mjs'
import * as session from '../packages/session/dist/index.mjs'
import { createCsrfSessionAccessor } from '../packages/core/src/portable/csrfSession.ts'

const root = resolve(import.meta.dirname, '..')
const directory = await mkdtemp(join(tmpdir(), 'holo-native-browser-forms-'))
const entry = join(directory, 'entry.js')
const bundle = join(directory, 'client.js')
await writeFile(entry, `
import { createElement, useEffect } from ${JSON.stringify(join(root, 'node_modules/react/index.js'))}
import { createRoot } from ${JSON.stringify(join(root, 'node_modules/react-dom/client.js'))}
import { useForm } from ${JSON.stringify(join(root, 'packages/adapter-next/src/client.ts'))}
import { createFormClient, runWithBrowserFormElement } from ${JSON.stringify(join(root, 'packages/forms/src/internal/client.ts'))}
import { field, schema } from ${JSON.stringify(join(root, 'packages/validation/src/index.ts'))}
globalThis.mountInvitation = () => {
  const definition = schema({ token: field.string().required().max(2048), password: field.password().required().min(12).max(128) })
  function Invitation() {
    const form = useForm(definition, {
      initialValues: { token: '', password: '' },
      submitter: ({ values, formData }) => ({ ok: true, status: 200, data: { values, entries: Object.fromEntries(formData) } }),
    })
    useEffect(() => { void form.fields.token.onInput('invitation-token') }, [])
    return createElement('form', { onSubmit: event => {
      event.preventDefault()
      void form.submit().then(result => { globalThis.invitationResult = result })
    } },
    createElement('input', { name: 'password', type: 'password', value: form.values.password, onChange: event => { void form.fields.password.onInput(event.target.value) } }),
    createElement('button', { type: 'submit' }, 'Accept'))
  }
  const container = document.createElement('div')
  document.body.append(container)
  createRoot(container).render(createElement(Invitation))
}
globalThis.submitEndpointForm = async (apiUrl) => {
  const form = createFormClient(schema({ email: field.string().required().email() }), {
    action: apiUrl + '/contact', credentials: 'include', csrf: { endpoint: apiUrl + '/csrf' },
    initialValues: { email: 'ava@example.com' },
  })
  return await form.submit()
}
globalThis.submitNativeForm = async (method) => {
  const form = createFormClient(schema({ email: field.string().required().email() }), {
    method,
    initialValues: { email: 'ava@example.com' },
    submitter: ({ formData }) => ({ ok: true, status: 200, data: Object.fromEntries(formData) }),
  })
  return await form.submit()
}
globalThis.mountSurvey = () => {
  const definition = schema({ tags: field.array(field.string()).required(), pages: field.array({ key: field.string().required(), questions: field.array({ text: field.string().required(), required: field.boolean() }).default([]) }).required() })
  const initialValues = { tags: ['first', 'second'], pages: [{ key: 'first', questions: [{ text: 'First question', required: true }, { text: 'Second question', required: false }] }, { key: 'second', questions: [{ text: 'Third question', required: true }] }] }
  function Survey() {
    const form = useForm(definition, {
      initialValues,
      submitter: async ({ values, formData }) => {
        const { validate } = await import(${JSON.stringify(join(root, 'packages/validation/src/index.ts'))})
        return { ok: true, status: 200, data: { values, transported: await validate(formData, definition) } }
      },
    })
    return createElement('form', { onSubmit: event => {
      event.preventDefault()
      void form.submit().then(result => { globalThis.surveyResult = result })
    } },
    ...form.values.tags.map((tag, index) => createElement('input', { key: index, type: 'hidden', name: 'tags[' + index + ']', value: tag })),
    createElement('output', { id: 'survey-questions' }, form.values.pages.flatMap(page => page.questions.map(question => question.text)).join(', ')),
    createElement('button', { type: 'submit' }, 'Publish survey'))
  }
  const container = document.createElement('div')
  document.body.append(container)
  createRoot(container).render(createElement(Survey))
}
globalThis.submitNativeUpload = async () => {
  const form = createFormClient(schema({ title: field.string().required(), image: field.file().optional() }), {
    initialValues: { title: '' },
    submitter: async ({ values, formData }) => {
      const image = formData.get('image')
      return { ok: true, status: 200, data: { title: values.title, name: image.name, bytes: image.size, content: await image.text(), sharedFile: image === values.image } }
    },
  })
  return await runWithBrowserFormElement(form, document.querySelector('#upload'))
}
globalThis.submitRenderedCsrfForm = async () => {
  const form = createFormClient(schema({ email: field.string().required().email() }), {
    submitter: ({ formData }) => ({ ok: true, status: 200, data: Object.fromEntries(formData) }),
  })
  return await runWithBrowserFormElement(form, document.getElementById('rendered'))
}
globalThis.submitNativeConcurrentForms = async () => {
  return await Promise.all(['first', 'second'].map(id => {
    const form = createFormClient(schema({ email: field.string().required().email() }), {
      submitter: async ({ formData, action }) => {
        await new Promise(resolve => setTimeout(resolve, id === 'first' ? 20 : 1))
        return { ok: true, status: 200, data: { email: formData.get('email'), action: new URL(action).pathname } }
      },
    })
    return runWithBrowserFormElement(form, document.getElementById(id))
  }))
}

`)
execFileSync('bun', ['build', entry, '--target=browser', '--outfile', bundle], { cwd: root, stdio: 'pipe' })
const javascript = await readFile(bundle)
const server = createServer((request, response) => {
  if (request.url === '/client.js') {
    response.setHeader('content-type', 'text/javascript')
    response.end(javascript)
    return
  }
  response.setHeader('content-type', 'text/html')
  response.end('<!doctype html><title>Native form client</title><form id="upload"><input name="title" value="Native upload"><input name="image" type="file"></form><form id="first" action="/first" method="post"><input name="email" value="first@example.com"></form><form id="second" action="/second" method="post"><input name="email" value="second@example.com"></form><form id="rendered" action="/rendered" method="post"><input name="email" value="ava@example.com"><input type="hidden" name="_token" value="server-rendered-token"></form><script src="/client.js"></script>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const url = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ headless: true })

try {
  await test('forms use native browser cookies and native FormData', { concurrency: 3 }, async suite => {
    await Promise.all([
      { name: 'attaches the default CSRF cookie on unsafe submissions', cookie: 'XSRF-TOKEN=client-token', method: 'POST', expected: { email: 'ava@example.com', _token: 'client-token' } },
      { name: 'ignores malformed unrelated cookies while reading the native CSRF cookie', cookie: 'tracking=%; XSRF-TOKEN=client-token', method: 'POST', expected: { email: 'ava@example.com', _token: 'client-token' } },
      { name: 'reads custom CSRF names from the real security client configuration cookie', cookie: 'csrf-token=custom-token; HOLO-CSRF-CONFIG=' + encodeURIComponent(JSON.stringify({ csrf: { field: '_csrf', header: 'X-App-CSRF', cookie: 'csrf-token' } })), method: 'POST', expected: { email: 'ava@example.com', _csrf: 'custom-token' } },
      { name: 'reads custom CSRF names from configuration cookies issued before the header name was added', cookie: 'csrf-token=custom-token; HOLO-CSRF-CONFIG=' + encodeURIComponent(JSON.stringify({ csrf: { field: '_csrf', cookie: 'csrf-token' } })), method: 'POST', expected: { email: 'ava@example.com', _csrf: 'custom-token' } },
      { name: 'omits CSRF fields for safe submissions', cookie: 'XSRF-TOKEN=safe-token', method: 'GET', expected: { email: 'ava@example.com' } },
      { name: 'omits CSRF fields when the browser has no token cookie', cookie: '', method: 'POST', expected: { email: 'ava@example.com' } },
    ].map(scenario => suite.test(scenario.name, async () => {
      const context = await browser.newContext()
      try {
        if (scenario.cookie) {
          await context.addCookies(scenario.cookie.split('; ').map(segment => {
            const separator = segment.indexOf('=')
            return { name: segment.slice(0, separator), value: segment.slice(separator + 1), url }
          }))
        }
        const page = await context.newPage()
        await page.goto(url)
        await page.waitForFunction(() => typeof globalThis.submitNativeForm === 'function')
        const result = await page.evaluate(method => globalThis.submitNativeForm(method), scenario.method)
        assert.deepEqual(result, { ok: true, status: 200, data: scenario.expected })
      } finally {
        await context.close()
      }
    })))
    await suite.test('submits cross-origin endpoint metadata with custom API names and keeps legacy responses working', async () => {
      const store = session.createFileSessionStore(join(directory, 'sessions'))
      session.configureSessionRuntime({
        config: session.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: join(directory, 'sessions') } } }),
        stores: { file: store }, appKey: 'native-cross-origin-key',
      })
      try {
        for (const metadata of [true, false]) {
          configureSecurityRuntime({
            config: defineSecurityConfig({
              csrf: { enabled: true, ...(metadata ? { field: '_api_csrf', header: 'X-API-CSRF', cookie: 'api-xsrf' } : {}) },
            }),
            cors: { paths: ['*'], origins: [url], credentials: true },
            csrfSigningKey: 'native-cross-origin-key',
            csrfSession: createCsrfSessionAccessor(session, () => 'holo_session'),
          })
          const api = createServer(async (incoming, outgoing) => {
            const headers = new Headers()
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (typeof value === 'string') headers.set(name, value)
            }
            const chunks = []
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
            const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
              method: incoming.method, headers,
              ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
            })
            let result = cors.preflight(request)
            if (!result) {
              try {
                if (incoming.url === '/csrf') {
                  const { name: field, value: token } = await csrf.field(request)
                  result = Response.json(metadata ? { token, field } : { token })
                } else {
                  await csrf.verify(request)
                  result = Response.json({ ok: true, status: 201, data: { submitted: true } }, { status: 201 })
                }
              } catch {
                result = new Response('CSRF validation failed', { status: 419 })
              }
            }
            const response = cors.apply(request, result)
            outgoing.writeHead(response.status, Object.fromEntries(response.headers))
            outgoing.end(Buffer.from(await response.arrayBuffer()))
          })
          await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
          const address = api.address()
          assert.ok(address && typeof address !== 'string')
          const apiUrl = `http://127.0.0.1:${address.port}`
          assert.notEqual(new URL(apiUrl).origin, new URL(url).origin)
          const context = await browser.newContext()
          try {
            const record = await session.createSession({ data: { _token: 'native-api-session-token' } })
            const cookie = session.getSessionRuntime().sessionCookie(record.id).split(';', 1)[0]
            const separator = cookie.indexOf('=')
            await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: apiUrl, httpOnly: true }])
            const page = await context.newPage()
            await page.goto(url)
            assert.equal(await page.evaluate(() => document.cookie), '')
            const result = await page.evaluate(apiUrl => globalThis.submitEndpointForm(apiUrl), apiUrl)
            assert.deepEqual(result, { ok: true, status: 201, data: { submitted: true } }, metadata ? 'Custom API field metadata must work across origins.' : 'Legacy token-only responses must retain their transport.')
          } finally {
            await context.close()
            api.closeAllConnections()
            await new Promise(resolve => api.close(resolve))
          }
        }
      } finally {
        resetSecurityRuntime()
        session.configureSessionRuntime(undefined)
      }
    })
    await suite.test('preserves native file input content when submitting a real browser form', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.goto(url)
        await page.locator('input[type="file"]').setInputFiles({ name: 'image.txt', mimeType: 'text/plain', buffer: Buffer.from('native file content') })
        const result = await page.evaluate(() => globalThis.submitNativeUpload())
        assert.deepEqual(result, { ok: true, status: 200, data: { title: 'Native upload', name: 'image.txt', bytes: 19, content: 'native file content', sharedFile: true } })
      } finally {
        await context.close()
      }
    })
    await suite.test('submits programmatic fields alongside controlled inputs through native Next useForm', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.goto(url)
        await page.evaluate(() => globalThis.mountInvitation())
        await page.locator('input[name="password"]').fill('secure-password')
        await page.getByRole('button', { name: 'Accept' }).click()
        await page.waitForFunction(() => globalThis.invitationResult !== undefined)
        const result = await page.evaluate(() => globalThis.invitationResult)
        const expected = { token: 'invitation-token', password: 'secure-password' }
        assert.deepEqual(result, { ok: true, status: 200, data: { values: expected, entries: expected } })
      } finally {
        await context.close()
      }
    })
    await suite.test('keeps a server-rendered CSRF token instead of the cookie value', async () => {
      const context = await browser.newContext()
      try {
        await context.addCookies([{ name: 'XSRF-TOKEN', value: 'encrypted-cookie-token', url }])
        const page = await context.newPage()
        await page.goto(url)
        const result = await page.evaluate(() => globalThis.submitRenderedCsrfForm())
        assert.deepEqual(result, { ok: true, status: 200, data: { email: 'ava@example.com', _token: 'server-rendered-token' } })
      } finally {
        await context.close()
      }
    })
    await suite.test('keeps concurrently submitted native forms and their action URLs isolated', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.goto(url)
        const results = await page.evaluate(() => globalThis.submitNativeConcurrentForms())
        assert.deepEqual(results, [
          { ok: true, status: 200, data: { email: 'first@example.com', action: '/first' } },
          { ok: true, status: 200, data: { email: 'second@example.com', action: '/second' } },
        ])
      } finally {
        await context.close()
      }
    })
    await suite.test('preserves nested array items in React state and server validation when submitting a native form', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.goto(url)
        await page.evaluate(() => globalThis.mountSurvey())
        await page.getByRole('button', { name: 'Publish survey' }).click()
        await page.waitForFunction(() => globalThis.surveyResult !== undefined)
        const expected = { tags: ['first', 'second'], pages: [{ key: 'first', questions: [{ text: 'First question', required: true }, { text: 'Second question', required: false }] }, { key: 'second', questions: [{ text: 'Third question', required: true }] }] }
        assert.deepEqual(await page.evaluate(() => globalThis.surveyResult), { ok: true, status: 200, data: { values: expected, transported: expected } })
        assert.equal(await page.locator('#survey-questions').textContent(), 'First question, Second question, Third question')
      } finally {
        await context.close()
      }
    })

  })
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
