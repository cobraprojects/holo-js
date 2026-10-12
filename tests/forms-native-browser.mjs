import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright'

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
globalThis.submitNativeForm = async (method) => {
  const form = createFormClient(schema({ email: field.string().required().email() }), {
    method,
    initialValues: { email: 'ava@example.com' },
    submitter: ({ formData }) => ({ ok: true, status: 200, data: Object.fromEntries(formData) }),
  })
  return await form.submit()
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
  response.end('<!doctype html><title>Native form client</title><form id="upload"><input name="title" value="Native upload"><input name="image" type="file"></form><form id="first" action="/first" method="post"><input name="email" value="first@example.com"></form><form id="second" action="/second" method="post"><input name="email" value="second@example.com"></form><script src="/client.js"></script>')
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
      { name: 'reads custom CSRF names from the real security client configuration cookie', cookie: 'csrf-token=custom-token; HOLO-CSRF-CONFIG=' + encodeURIComponent(JSON.stringify({ csrf: { field: '_csrf', cookie: 'csrf-token' } })), method: 'POST', expected: { email: 'ava@example.com', _csrf: 'custom-token' } },
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

  })
} finally {
  await browser.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
