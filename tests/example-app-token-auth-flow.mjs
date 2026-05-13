import assert from 'node:assert/strict'

async function fetchJson(baseUrl, path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
    redirect: 'manual',
  })
  const text = await response.text()

  try {
    return {
      response,
      json: JSON.parse(text),
    }
  } catch (error) {
    throw new Error(`Expected JSON from ${path}: ${error instanceof Error ? error.message : String(error)}\n${text}`)
  }
}

async function fetchText(baseUrl, path) {
  const response = await fetch(new URL(path, baseUrl), {
    method: 'GET',
    redirect: 'manual',
  })
  const text = await response.text()

  return {
    response,
    text,
  }
}

async function createTokenFromCredentials(baseUrl) {
  const formData = new FormData()
  formData.set('email', 'editor@example.com')
  formData.set('password', 'secret')

  const result = await fetchJson(baseUrl, '/api/v1/tokens', {
    method: 'POST',
    body: formData,
  })

  assert.equal(result.response.status, 200)
  assert.equal(result.json.ok, true)
  assert.match(result.json.token, /^[^.]+\..+$/)
  assert.equal(result.json.tokenId, result.json.token.split('.', 1)[0])
  assert.deepEqual(result.json.abilities, ['posts.read'])

  return result.json.token
}

export async function assertExampleAppTokenAuthFlow({ baseUrl, expectedTitle }) {
  const tokenPage = await fetchText(baseUrl, '/api-token-posts')
  assert.equal(tokenPage.response.status, 200)
  assert.match(tokenPage.text, /API token posts/i)

  const missingToken = await fetchJson(baseUrl, '/api/v1/posts')
  assert.equal(missingToken.response.status, 401)
  assert.equal(missingToken.json.ok, false)
  assert.equal(missingToken.json.message, 'Unauthenticated.')

  const badToken = await fetchJson(baseUrl, '/api/v1/posts', {
    headers: {
      Authorization: 'Bearer bad-token',
    },
  })
  assert.equal(badToken.response.status, 401)
  assert.equal(badToken.json.ok, false)

  const invalidCredentials = new FormData()
  invalidCredentials.set('email', 'editor@example.com')
  invalidCredentials.set('password', 'wrong-secret')
  const rejectedToken = await fetchJson(baseUrl, '/api/v1/tokens', {
    method: 'POST',
    body: invalidCredentials,
  })
  assert.equal(rejectedToken.response.status, 401)
  assert.equal(rejectedToken.json.ok, false)
  assert.equal(rejectedToken.json.message, 'Invalid credentials.')

  const token = await createTokenFromCredentials(baseUrl)
  const validToken = await fetchJson(baseUrl, '/api/v1/posts', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  assert.equal(validToken.response.status, 200)
  assert.equal(validToken.json.ok, true)
  assert.ok(Array.isArray(validToken.json.posts))
  assert.ok(validToken.json.posts.some(post => post.title === expectedTitle))
}
