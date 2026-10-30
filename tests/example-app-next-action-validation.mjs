import assert from 'node:assert/strict'
import { newExampleAppContext, observeExampleAppPage } from './example-app-browser.mjs'

export async function assertNextServerActionValidationFlow({ baseUrl, getOutput }) {
  const outputStart = getOutput().length
  const context = await newExampleAppContext({ baseURL: baseUrl })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page)
    const actionStatuses = []
    page.on('response', (response) => {
      if (response.request().headers()['next-action']) actionStatuses.push(response.status())
    })
    await page.goto('/register', { waitUntil: 'networkidle' })
    await page.getByLabel('Name').fill('Taken Email')
    await page.getByLabel('Email').fill('editor@example.com')
    await page.getByLabel('Password', { exact: true }).fill('Correct-Horse-Battery-9')
    await page.getByLabel('Confirm password').fill('Correct-Horse-Battery-9')
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    await page.getByText('A user with this email already exists.', { exact: true }).waitFor({ timeout: 15000 }).catch(async (error) => {
      throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${observed.failures.join('\n')}\n${getOutput().slice(outputStart)}`)
    })

    assert.deepEqual(actionStatuses, [200])
    assert.equal(new URL(page.url()).pathname, '/register')
    assert.deepEqual(observed.failures, [])
    const output = getOutput().slice(outputStart)
    assert.doesNotMatch(output, /ValidationException|HOLO_VALIDATION/, output)
  } finally {
    await context.close()
  }
}
