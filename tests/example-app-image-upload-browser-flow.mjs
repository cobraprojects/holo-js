import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { newExampleAppContext, observeExampleAppPage, signInAsExampleAppEditor } from './example-app-browser.mjs'

const imageError = 'The selected file must be an image.'
const imageFixtures = new URL('../packages/validation/tests/fixtures/images/', import.meta.url)

const rejectedUploads = [
  { fixture: 'disguised-avatar.png', name: 'avatar.png', mimeType: 'image/png' },
  { fixture: 'scripted.svg', name: 'logo.svg', mimeType: 'image/svg+xml' },
  { fixture: 'truncated.png', name: 'cut-off.png', mimeType: 'image/png' },
  { fixture: 'corrupted-pixels.png', name: 'damaged.png', mimeType: 'image/png' },
]

async function uploadPostImage(page, { fixture, name, mimeType }) {
  const title = `Image upload ${fixture} ${Date.now()}`
  await page.goto('/admin/posts/new', { waitUntil: 'networkidle' })
  await page.locator('[name="title"]').fill(title)
  await page.locator('[name="excerpt"]').fill('Uploaded through the real post form in the browser.')
  await page.locator('[name="body"]').fill('This post checks that only real, complete images are accepted as post images.')
  await page.locator('[name="image"]').setInputFiles({ name, mimeType, buffer: await readFile(new URL(fixture, imageFixtures)) })
  await page.getByRole('button', { name: 'Create post', exact: true }).click()
  return title
}

async function postIsListed(page, title) {
  const listing = await page.request.get('/admin/posts')
  assert.equal(listing.status(), 200)
  return (await listing.text()).includes(title)
}

export async function assertExampleAppImageUploadBrowserFlow({ baseUrl }) {
  const context = await newExampleAppContext({ baseURL: baseUrl })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page, { allowConsoleError: text => text.includes('status of 422') })
    await signInAsExampleAppEditor(page)

    for (const upload of rejectedUploads) {
      const title = await uploadPostImage(page, upload)
      await page.getByText(imageError, { exact: true }).waitFor({ timeout: 20000 }).catch(async (error) => {
        throw new Error(`Expected ${upload.fixture} to be rejected as an image. ${error.message}\n${await page.locator('body').innerText()}`)
      })
      assert.equal(await postIsListed(page, title), false, `Expected the rejected ${upload.fixture} upload to save no post.`)
    }

    const title = await uploadPostImage(page, { fixture: 'valid.png', name: 'cover.png', mimeType: 'image/png' })
    await page.waitForURL(url => url.pathname === '/admin/posts', { timeout: 20000 })
    assert.equal(await postIsListed(page, title), true, 'Expected a complete PNG to be accepted as a post image.')
    assert.deepEqual(observed.failures, [])
  } finally {
    await context.close()
  }
}
