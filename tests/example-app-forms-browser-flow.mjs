import assert from 'node:assert/strict'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'

export async function assertExampleAppFormsBrowserFlow({ baseUrl, framework }) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page)
    const response = await page.goto('/framework/forms', { waitUntil: 'networkidle' })
    assert.equal(response.status(), 200)
    assert.equal(await page.locator('[data-form-city]').textContent(), 'missing')
    await page.getByRole('button', { name: 'Load profile', exact: true }).click()
    await page.waitForFunction(() => globalThis.document.querySelector('[data-form-city]')?.textContent === 'Cairo')
    await page.getByRole('button', { name: 'Add tag', exact: true }).click()
    await page.waitForFunction(() => globalThis.document.querySelector('[data-form-tags]')?.textContent === 'first,second')
    assert.equal(await page.locator('[data-form-dirty]').textContent(), 'dirty')
    await page.getByRole('button', { name: 'Submit sample', exact: true }).click()
    await page.waitForFunction(() => globalThis.document.querySelector('[data-form-result]')?.textContent.includes('Cairo'))
    assert.deepEqual(JSON.parse(await page.locator('[data-form-result]').textContent()), { city: 'Cairo', tags: ['first', 'second'] })
    await page.getByRole('button', { name: 'Reset sample', exact: true }).click()
    await page.waitForFunction(() => globalThis.document.querySelector('[data-form-city]')?.textContent === 'missing')
    assert.equal(await page.locator('[data-form-tags]').textContent(), 'first')
    assert.equal(await page.locator('[data-form-dirty]').textContent(), 'clean')
    if (framework === 'sveltekit') {
      await page.getByLabel('HTTP contact email').fill('nora@example.com')
      await page.getByRole('button', { name: 'Submit HTTP contact', exact: true }).click()
      await page.waitForFunction(() => globalThis.document.querySelector('[data-http-contact-result]')?.textContent.includes('nora@example.com'))
      assert.deepEqual(JSON.parse(await page.locator('[data-http-contact-result]').textContent()), { email: 'nora@example.com' })
    }
    assert.deepEqual(observed.failures, [])
    await page.getByRole('button', { name: 'Trigger forbidden', exact: true }).click()
    await page.getByRole('heading', { name: '403', exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
      throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${observed.failures.join('\n')}`)
    })
  } finally {
    await context.close()
  }

  if (framework === 'nuxt') {
    const requestContext = await browser.newContext({ baseURL: baseUrl })
    try {
      assert.equal((await requestContext.request.get('/framework/forms')).status(), 200)
      const csrf = (await requestContext.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
      assert.ok(csrf)
      const headers = { 'X-CSRF-TOKEN': decodeURIComponent(csrf.value), Origin: baseUrl }
      const apiFailure = await requestContext.request.post('/framework/forms', {
        form: { email: 'invalid' },
        headers: { ...headers, Accept: 'application/json' },
        maxRedirects: 0,
      })
      assert.equal(apiFailure.status(), 422)
      assert.equal(apiFailure.headers().location, undefined)
      assert.deepEqual((await apiFailure.json()).errors, { email: ['Email rejected for profile.'] })
      assert.ok(!(await requestContext.cookies()).some(cookie => cookie.name === 'holo_form_failure'))
      for (const referer of ['%%%bad-url', 'https://evil.test/framework/forms']) {
        const browserFailure = await requestContext.request.post('/framework/forms', {
          form: { email: 'invalid' },
          headers: { ...headers, Referer: referer, Accept: 'text/html' },
          maxRedirects: 0,
        })
        assert.equal(browserFailure.status(), 303)
        assert.equal(browserFailure.headers().location, '/framework/forms')
      }
    } finally {
      await requestContext.close()
    }
  }

  const paths = framework === 'sveltekit' ? ['/framework/forms', '/framework/forms/default'] : ['/framework/forms']
  await Promise.all(paths.flatMap(path => [false, true].map(async javaScriptEnabled => {
    const flashContext = await browser.newContext({ baseURL: baseUrl, javaScriptEnabled })
    try {
      const page = await flashContext.newPage()
      const observed = observeExampleAppPage(page, { allowRequestFailure: (_url, failure) => !javaScriptEnabled && failure === 'csp' })
      await page.goto(path, { waitUntil: javaScriptEnabled ? 'networkidle' : 'domcontentloaded' })
      const csrf = (await flashContext.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
      assert.ok(csrf, 'The native form page must issue a CSRF cookie.')
      const failure = await flashContext.request.post(path, {
        form: { email: 'invalid', password: 'private-form-password' },
        headers: { 'X-CSRF-TOKEN': decodeURIComponent(csrf.value), Origin: baseUrl, Referer: `${baseUrl}${path}`, Accept: 'text/html' },
        maxRedirects: 0,
      })
      assert.equal(failure.status(), 303)
      if (framework === 'nuxt') assert.equal((await flashContext.cookies()).find(cookie => cookie.name === 'holo_native_form')?.value, 'retained', 'Validation redirects must preserve cookies written by the native handler.')
      assert.ok((await flashContext.cookies()).some(cookie => cookie.name === (framework === 'nuxt' ? 'holo_form_failure' : 'HOLO-SVELTEKIT-VALIDATION')))
      const response = await page.goto(path, { waitUntil: javaScriptEnabled ? 'networkidle' : 'domcontentloaded' })
      assert.equal(response.status(), 200)
      if (path.endsWith('/default')) {
        assert.equal(await page.locator('[data-contact-error]').textContent(), 'Email rejected for contact.')
        assert.equal(await page.getByLabel('Contact email', { exact: true }).inputValue(), 'invalid')
        assert.equal(await page.getByLabel('Contact password', { exact: true }).inputValue(), '')
      } else {
        assert.equal(await page.locator('[data-default-error]').textContent(), '')
        assert.equal(await page.locator('[data-profile-error]').textContent(), 'Email rejected for profile.')
        if (framework === 'sveltekit') assert.equal(await page.locator('[data-http-contact-error]').textContent(), '')
      }
      assert.deepEqual(observed.failures, [])
    } finally {
      await flashContext.close()
    }
  })))
}
