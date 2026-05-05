import assert from 'node:assert/strict'

function createCookieJar() {
  const cookies = new Map()

  return {
    apply(headers) {
      if (cookies.size === 0) {
        return
      }

      headers.set('cookie', [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '))
    },
    capture(response) {
      const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : (
            response.headers.get('set-cookie')
              ? [response.headers.get('set-cookie')]
              : []
          )

      for (const setCookie of setCookies) {
        const firstSegment = setCookie.split(';', 1)[0] ?? ''
        const equalsIndex = firstSegment.indexOf('=')
        if (equalsIndex <= 0) {
          continue
        }

        const name = firstSegment.slice(0, equalsIndex).trim()
        const value = firstSegment.slice(equalsIndex + 1).trim()

        if (value.length === 0) {
          cookies.delete(name)
          continue
        }

        cookies.set(name, value)
      }
    },
  }
}

function listSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie()
  }

  const fallback = response.headers.get('set-cookie')
  return fallback ? [fallback] : []
}

async function fetchText(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers ?? {})
  options.jar?.apply(headers)

  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
    redirect: 'manual',
  })

  options.jar?.capture(response)

  const text = await response.text()
  if ((response.status < 200 || response.status >= 300) && options.allowFailure !== true) {
    throw new Error(`Unexpected status ${response.status} for ${path}: ${text}`)
  }

  return {
    response,
    text,
  }
}

async function fetchJson(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers ?? {})
  let body = options.body

  if (options.fields) {
    const payload = new FormData()
    for (const [key, value] of Object.entries(options.fields)) {
      if (typeof value === 'undefined' || value === null) {
        continue
      }

      payload.set(key, String(value))
    }

    body = payload
  }

  const result = await fetchText(baseUrl, path, {
    method: options.method ?? (options.fields ? 'POST' : 'GET'),
    headers,
    body,
    jar: options.jar,
    allowFailure: options.allowFailure,
  })

  try {
    return {
      response: result.response,
      json: JSON.parse(result.text),
    }
  } catch (error) {
    throw new Error(`Expected JSON from ${path}: ${error instanceof Error ? error.message : String(error)}\n${result.text}`)
  }
}

async function waitForOutputMatch(getOutput, matcher, startIndex = 0, timeoutMs = 10000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const output = getOutput().slice(startIndex)
    const match = output.match(matcher)
    if (match) {
      return match
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error(`Timed out waiting for auth mail output to match ${matcher}`)
}

const authTokenPattern = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]+)/i

export async function assertExampleAppAuthFlow({
  baseUrl,
  getOutput,
  appName,
}) {
  const email = `${appName}-${Date.now()}@app.test`
  const password = 'secret-secret'
  const nextPassword = 'secret-secret-2'
  const clientIp = `127.0.0.${(Date.now() % 200) + 1}`
  const requestHeaders = {
    'x-forwarded-for': clientIp,
    'x-real-ip': clientIp,
  }

  const fetchAuthText = (path, options = {}) => fetchText(baseUrl, path, {
    ...options,
    headers: {
      ...requestHeaders,
      ...(options.headers ?? {}),
    },
  })
  const fetchAuthJson = (path, options = {}) => fetchJson(baseUrl, path, {
    ...options,
    headers: {
      ...requestHeaders,
      ...(options.headers ?? {}),
    },
  })

  const loginPage = await fetchAuthText('/login')
  assert.match(loginPage.text, /Sign in/i)

  const registerPage = await fetchAuthText('/register')
  assert.match(registerPage.text, /Create account/i)

  const forgotPasswordPage = await fetchAuthText('/forgot-password')
  assert.match(forgotPasswordPage.text, /Forgot password/i)

  const verifyPromptPage = await fetchAuthText('/verify-email')
  assert.match(verifyPromptPage.text, /Verify your email/i)

  const initialUser = await fetchAuthJson('/api/auth/user')
  assert.equal(initialUser.json.authenticated, false)
  assert.equal(initialUser.json.user, null)

  const registerOutputStart = getOutput().length
  const registeredJar = createCookieJar()
  const registered = await fetchAuthJson('/api/register', {
    fields: {
      name: 'Auth Flow User',
      email,
      password,
      passwordConfirmation: password,
    },
    jar: registeredJar,
  })
  assert.equal(registered.response.status, 201)
  assert.equal(registered.json.ok, true)
  assert.equal(registered.json.data?.message, 'Account created. Check your inbox to verify your email address.')
  assert.equal(registered.json.data?.redirectTo, `/verify-email?email=${encodeURIComponent(email)}`)
  assert.ok(listSetCookieHeaders(registered.response).length > 0)

  const verificationToken = (
    await waitForOutputMatch(
      getOutput,
      authTokenPattern,
      registerOutputStart,
    )
  )[1]
  assert.ok(verificationToken)

  const pendingVerificationJar = createCookieJar()
  const unverifiedLogin = await fetchAuthJson('/api/login', {
    fields: {
      email,
      password,
    },
    jar: pendingVerificationJar,
  })
  assert.equal(unverifiedLogin.json.ok, true)
  assert.equal(unverifiedLogin.json.data?.redirectTo, `/verify-email?email=${encodeURIComponent(email)}`)

  const resendOutputStart = getOutput().length
  const resent = await fetchAuthJson('/api/verify-email/resend', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: {
      'content-type': 'application/json',
    },
  })
  assert.equal(resent.json.ok, true)
  assert.equal(resent.json.data?.message, 'A fresh verification email has been sent.')

  const resentVerificationToken = (
    await waitForOutputMatch(
      getOutput,
      authTokenPattern,
      resendOutputStart,
    )
  )[1]
  assert.ok(resentVerificationToken)

  const verifyTokenPage = await fetchAuthText(
    `/verify-email?token=${encodeURIComponent(resentVerificationToken)}`,
  )
  assert.match(verifyTokenPage.text, /Verify your email/i)

  const verified = await fetchAuthJson('/api/verify-email', {
    method: 'POST',
    fields: {
      token: resentVerificationToken,
    },
  })
  assert.equal(verified.json.ok, true)
  assert.equal(verified.json.data?.redirectTo, '/login')

  const authenticatedJar = createCookieJar()
  const loggedIn = await fetchAuthJson('/api/login', {
    fields: {
      email,
      password,
    },
    jar: authenticatedJar,
  })
  assert.equal(loggedIn.json.ok, true)
  assert.equal(loggedIn.json.data?.message, 'Signed in successfully.')
  assert.equal(loggedIn.json.data?.redirectTo, '/admin')
  assert.ok(listSetCookieHeaders(loggedIn.response).length > 0)

  const authenticatedUser = await fetchAuthJson('/api/auth/user', {
    jar: authenticatedJar,
  })
  assert.equal(authenticatedUser.json.authenticated, true)
  assert.equal(authenticatedUser.json.guard, 'web')
  assert.equal(authenticatedUser.json.user?.email, email)
  assert.equal(authenticatedUser.json.user?.name, 'Auth Flow User')

  const outputStart = getOutput().length
  const forgotPassword = await fetchAuthJson('/api/forgot-password', {
    fields: {
      email,
    },
  })
  assert.equal(forgotPassword.json.ok, true)
  assert.equal(forgotPassword.json.data?.message, 'If an account exists for that email, a reset link has been sent.')

  const resetTokenMatch = await waitForOutputMatch(
    getOutput,
    authTokenPattern,
    outputStart,
  )
  const resetToken = resetTokenMatch[1]
  assert.ok(resetToken)

  const resetPage = await fetchAuthText(`/reset-password?token=${encodeURIComponent(resetToken)}`)
  assert.match(resetPage.text, /Reset password/i)

  const resetResult = await fetchAuthJson('/api/reset-password', {
    fields: {
      token: resetToken,
      password: nextPassword,
      passwordConfirmation: nextPassword,
    },
  })
  assert.equal(resetResult.json.ok, true)
  assert.equal(resetResult.json.data?.message, 'Password reset successfully. You can sign in with your new password.')
  assert.equal(resetResult.json.data?.redirectTo, '/login')

  const oldPasswordLogin = await fetchAuthJson('/api/login', {
    fields: {
      email,
      password,
    },
    allowFailure: true,
  })
  assert.equal(oldPasswordLogin.json.ok, false)

  const refreshedJar = createCookieJar()
  const newPasswordLogin = await fetchAuthJson('/api/login', {
    fields: {
      email,
      password: nextPassword,
    },
    jar: refreshedJar,
  })
  assert.equal(newPasswordLogin.json.ok, true)
  assert.ok(listSetCookieHeaders(newPasswordLogin.response).length > 0)

  const refreshedUser = await fetchAuthJson('/api/auth/user', {
    jar: refreshedJar,
  })
  assert.equal(refreshedUser.json.authenticated, true)
  assert.equal(refreshedUser.json.guard, 'web')
  assert.equal(refreshedUser.json.user?.email, email)
  assert.equal(refreshedUser.json.user?.name, 'Auth Flow User')
}
