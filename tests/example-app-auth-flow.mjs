import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

let csrfSigningKey = null

async function loadCsrfSigningKey() {
  if (csrfSigningKey) {
    return csrfSigningKey
  }

  if (process.env.APP_KEY?.trim()) {
    csrfSigningKey = process.env.APP_KEY.trim()
    return csrfSigningKey
  }

  const envSource = await readFile(`${process.cwd()}/.env`, 'utf8')
  const appKey = envSource.match(/^APP_KEY=(.*)$/m)?.[1]?.trim()
  if (!appKey) {
    throw new Error('Expected APP_KEY to be configured for CSRF auth-flow tests.')
  }

  csrfSigningKey = appKey.replace(/^['"]|['"]$/g, '')
  return csrfSigningKey
}

async function createCsrfToken() {
  const nonce = randomBytes(32).toString('base64url')
  const signature = createHmac('sha256', await loadCsrfSigningKey())
    .update(nonce)
    .digest('base64url')

  return `${nonce}.${signature}`
}

function createCookieJar() {
  const cookies = new Map()

  return {
    apply(headers) {
      if (cookies.size === 0) {
        return
      }

      headers.set('cookie', this.header())
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

        const clearsCookie = value.length === 0
          || /(?:^|;\s*)max-age=0(?:;|$)/i.test(setCookie)
          || /(?:^|;\s*)expires=thu,\s*01\s+jan\s+1970/i.test(setCookie)

        if (clearsCookie) {
          cookies.delete(name)
          continue
        }

        cookies.set(name, value)
      }
    },
    header() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    },
    headerExcept(excludedNames) {
      const excluded = new Set(excludedNames)
      return [...cookies.entries()]
        .filter(([name]) => !excluded.has(name))
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
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

function appendCookieHeader(headers, cookie) {
  const existing = headers.get('cookie')
  headers.set('cookie', existing ? `${existing}; ${cookie}` : cookie)
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

function assertRedirectsTo(result, expectedPath) {
  assert.ok(
    result.response.status >= 300 && result.response.status < 400,
    `Expected ${expectedPath} redirect, received status ${result.response.status}.`,
  )
  const location = result.response.headers.get('location')
  assert.ok(location, `Expected ${expectedPath} redirect to include a location header.`)
  assert.equal(new URL(location, result.response.url).pathname, expectedPath)
}

function assertFieldFailure(result, fields) {
  assert.equal(result.json.ok, false)
  assert.equal(result.json.valid, false)
  for (const field of fields) {
    assert.ok(
      Array.isArray(result.json.errors?.[field]),
      `Expected ${field} validation errors.`,
    )
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hydrateFlattenedActionData(values, index, seen = new Map()) {
  if (!Array.isArray(values) || !Number.isInteger(index) || index < 0 || index >= values.length) {
    return undefined
  }

  if (seen.has(index)) {
    return seen.get(index)
  }

  const value = values[index]
  if (Array.isArray(value)) {
    const hydrated = []
    seen.set(index, hydrated)
    for (const itemIndex of value) {
      hydrated.push(typeof itemIndex === 'number'
        ? hydrateFlattenedActionData(values, itemIndex, seen)
        : itemIndex)
    }
    return hydrated
  }

  if (isRecord(value)) {
    const hydrated = {}
    seen.set(index, hydrated)
    for (const [key, itemIndex] of Object.entries(value)) {
      hydrated[key] = typeof itemIndex === 'number'
        ? hydrateFlattenedActionData(values, itemIndex, seen)
        : itemIndex
    }
    return hydrated
  }

  return value
}

function parseActionData(value) {
  if (isRecord(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) {
      return parsed
    }

    const hydrated = hydrateFlattenedActionData(parsed, 0)
    if (isRecord(hydrated)) {
      return hydrated
    }
  } catch {
    // Non-JSON action data falls back to a root form failure.
  }

  return null
}

function normalizeActionFailure(actionResult) {
  const failure = parseActionData(actionResult.data) ?? actionResult
  const errors = isRecord(failure.errors)
    ? failure.errors
    : (
        isRecord(actionResult.errors)
          ? actionResult.errors
          : { _root: ['Form submission failed.'] }
      )

  return {
    ...failure,
    ok: failure.ok === true,
    valid: failure.valid === true,
    errors,
    actionResult,
  }
}

function assertThrottleFailure(result) {
  assert.equal(result.response.status, 429)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.valid, false)
  assert.ok(
    Array.isArray(result.json.errors?._root),
    'Expected throttled response to include a root error.',
  )
  assert.equal(typeof result.json.retryAfterSeconds, 'number')
  assert.equal(typeof result.json.retryAt, 'string')
}

function assertSocialRedirect(result, expected) {
  assert.ok(
    result.response.status >= 300 && result.response.status < 400,
    'Expected redirect status in 3xx range.',
  )
  const location = result.response.headers.get('location')
  assert.ok(location, `Expected ${expected.provider} redirect to include a location header.`)
  const authorizationUrl = new URL(location)
  assert.equal(authorizationUrl.origin, expected.origin)
  assert.equal(authorizationUrl.pathname, expected.pathname)
  assert.ok(authorizationUrl.searchParams.get('state'), `Expected ${expected.provider} redirect to include OAuth state.`)
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function assertExampleAppAuthFlow({
  baseUrl,
  getOutput,
  appName,
  sessionCookieName,
  checkPages = true,
  loginRequiresCsrf = false,
  authSubmissionMode = 'json',
}) {
  const email = `${appName}-${Date.now()}@app.test`
  const password = 'secret-secret'
  const nextPassword = 'secret-secret-2'
  const clientIp = `127.0.0.${(Date.now() % 200) + 1}`
  const throttleLoginIp = `127.0.1.${(Date.now() % 200) + 1}`
  const throttleRegisterIp = `127.0.2.${(Date.now() % 200) + 1}`
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
  const fetchCsrfProtectedAuthJson = async (path, options = {}) => {
    if (!loginRequiresCsrf) {
      return await fetchAuthJson(path, options)
    }

    const csrfToken = await createCsrfToken()
    const csrfCookie = `XSRF-TOKEN=${encodeURIComponent(csrfToken)}`
    const fields = {
      ...(options.fields ?? {}),
      _token: csrfToken,
    }

    if (options.jar) {
      options.jar.capture(new Response(null, {
        headers: {
          'set-cookie': `${csrfCookie}; Path=/; SameSite=Lax`,
        },
      }))

      return await fetchAuthJson(path, {
        ...options,
        fields,
      })
    }

    const headers = new Headers(options.headers ?? {})
    appendCookieHeader(headers, csrfCookie)

    return await fetchAuthJson(path, {
      ...options,
      fields,
      headers: Object.fromEntries(headers),
    })
  }
  const usesSvelteKitActions = authSubmissionMode === 'sveltekit-actions'
  const fetchActionSubmission = async (path, options = {}) => {
    const body = new FormData()
    for (const [key, value] of Object.entries(options.fields ?? {})) {
      if (typeof value === 'undefined' || value === null) {
        continue
      }

      body.set(key, String(value))
    }

    const headers = new Headers(options.headers ?? {})
    if (loginRequiresCsrf) {
      const csrfToken = await createCsrfToken()
      const csrfCookie = `XSRF-TOKEN=${encodeURIComponent(csrfToken)}`
      body.set('_token', csrfToken)
      if (options.jar) {
        options.jar.capture(new Response(null, {
          headers: {
            'set-cookie': `${csrfCookie}; Path=/; SameSite=Lax`,
          },
        }))
      } else {
        appendCookieHeader(headers, csrfCookie)
      }
    }

    const result = await fetchAuthText(path, {
      ...options,
      method: 'POST',
      headers: Object.fromEntries(headers),
      body,
      allowFailure: true,
    })
    const location = result.response.headers.get('location')
    if (result.response.status >= 300 && result.response.status < 400 && location) {
      const redirectUrl = new URL(location, result.response.url)
      return {
        response: result.response,
        json: {
          ok: true,
          data: {
            redirectTo: `${redirectUrl.pathname}${redirectUrl.search}`,
          },
        },
      }
    }

    try {
      const actionResult = JSON.parse(result.text)
      if (actionResult?.type === 'redirect' && typeof actionResult.location === 'string') {
        const redirectUrl = new URL(actionResult.location, result.response.url)
        return {
          response: result.response,
          json: {
            ok: true,
            data: {
              redirectTo: `${redirectUrl.pathname}${redirectUrl.search}`,
            },
          },
        }
      }

      if (actionResult?.type === 'failure') {
        return {
          response: result.response,
          json: normalizeActionFailure(actionResult),
        }
      }
    } catch {
      // Non-JSON action responses are handled as form failures below.
    }

    return {
      response: result.response,
      json: {
        ok: false,
        valid: false,
        errors: {
          _root: ['Form submission failed.'],
        },
      },
    }
  }
  const fetchLoginJson = (options = {}) => usesSvelteKitActions
    ? fetchActionSubmission('/login', options)
    : fetchCsrfProtectedAuthJson('/api/login', options)
  const fetchRegisterJson = (options = {}) => usesSvelteKitActions
    ? fetchActionSubmission('/register', options)
    : fetchCsrfProtectedAuthJson('/api/register', options)
  const fetchSuperAdminLoginJson = (options = {}) => usesSvelteKitActions
    ? fetchActionSubmission('/super-admin/login', options)
    : fetchCsrfProtectedAuthJson('/api/super-admin/login', options)

  const assertAuthFieldFailure = (result, fields) => {
    if (usesSvelteKitActions) {
      assert.ok(
        result.response.status >= 200 && result.response.status < 500,
        `Expected form action failure status, received ${result.response.status}.`,
      )
      assert.equal(result.json.ok, false)
      assert.equal(result.json.valid, false)
      assertFieldFailure(result, fields)
      return
    }

    assertFieldFailure(result, fields)
  }
  const assertAuthThrottleFailure = (result) => {
    if (usesSvelteKitActions) {
      assertAuthFieldFailure(result, ['_root'])
      return
    }

    assertThrottleFailure(result)
  }

  const assertGuestNav = (text) => {
    assert.match(text, />Login</i)
    assert.match(text, />Register</i)
    assert.doesNotMatch(text, />Logout</i)
  }

  const assertUserNav = (text) => {
    assert.match(text, /Auth Flow User/i)
    assert.match(text, />Logout</i)
    assert.doesNotMatch(text, />Login</i)
    assert.doesNotMatch(text, />Register</i)
  }

  if (checkPages) {
    const registerPage = await fetchAuthText('/register')
    assert.match(registerPage.text, /Create account/i)
    assert.match(registerPage.text, /Register with WorkOS/i)
    assertGuestNav(registerPage.text)

    const loginPage = await fetchAuthText('/login')
    assert.match(loginPage.text, /Sign in/i)
    assert.match(loginPage.text, /Continue with Google/i)
    assert.match(loginPage.text, /Continue with GitHub/i)
    assert.match(loginPage.text, /Continue with WorkOS/i)
    assertGuestNav(loginPage.text)

    const superAdminLoginPage = await fetchAuthText('/super-admin/login')
    assert.match(superAdminLoginPage.text, /Super Admin Sign In/i)

    const forgotPasswordPage = await fetchAuthText('/forgot-password')
    assert.match(forgotPasswordPage.text, /Forgot password/i)

    const verifyPromptPage = await fetchAuthText('/verify-email')
    assert.match(verifyPromptPage.text, /Verify your email/i)

    assertRedirectsTo(await fetchAuthText('/admin/posts', {
      allowFailure: true,
    }), '/login')

    assertRedirectsTo(await fetchAuthText('/super-admin', {
      allowFailure: true,
    }), '/super-admin/login')
  }

  const initialUser = await fetchAuthJson('/api/auth/user')
  assert.equal(initialUser.json.authenticated, false)
  assert.equal(initialUser.json.user, null)

  assertSocialRedirect(await fetchAuthText('/auth/google', {
    allowFailure: true,
  }), {
    provider: 'google',
    origin: 'https://accounts.google.com',
    pathname: '/o/oauth2/v2/auth',
  })
  assertSocialRedirect(await fetchAuthText('/auth/github', {
    allowFailure: true,
  }), {
    provider: 'github',
    origin: 'https://github.com',
    pathname: '/login/oauth/authorize',
  })

  const missingGoogleCallback = await fetchAuthJson('/auth/google/callback', {
    allowFailure: true,
  })
  assert.equal(missingGoogleCallback.response.status, 400)
  assert.equal(missingGoogleCallback.json.message, 'Missing OAuth state or code.')

  const missingGithubCallback = await fetchAuthJson('/auth/github/callback', {
    allowFailure: true,
  })
  assert.equal(missingGithubCallback.response.status, 400)
  assert.equal(missingGithubCallback.json.message, 'Missing OAuth state or code.')

  const missingWorkosCallback = await fetchAuthText('/api/auth/workos/callback', {
    allowFailure: true,
  })
  assertRedirectsTo(missingWorkosCallback, '/login')
  const missingWorkosCallbackLocation = missingWorkosCallback.response.headers.get('location')
  assert.ok(missingWorkosCallbackLocation, 'Expected WorkOS callback redirect to include a location header.')
  assert.ok(
    new URL(missingWorkosCallbackLocation, missingWorkosCallback.response.url).searchParams.has('error'),
    'Expected WorkOS callback redirect to include an error query parameter.',
  )

  if (loginRequiresCsrf) {
    const missingLoginCsrf = usesSvelteKitActions
      ? await fetchAuthText('/login', {
        method: 'POST',
        body: new URLSearchParams({
          email,
          password,
        }),
        headers: {
          'x-forwarded-for': '127.0.0.229',
          'x-real-ip': '127.0.0.229',
        },
        allowFailure: true,
      })
      : await fetchAuthJson('/api/login', {
      fields: {
        email,
        password,
      },
      headers: {
        'x-forwarded-for': '127.0.0.229',
        'x-real-ip': '127.0.0.229',
      },
      allowFailure: true,
    })
    if (usesSvelteKitActions) {
      assert.equal(missingLoginCsrf.response.status, 200)
      assert.match(missingLoginCsrf.text, /CSRF token mismatch/i)
    } else {
      assert.equal(missingLoginCsrf.response.status, 419)
      assertFieldFailure(missingLoginCsrf, ['_root'])
    }
  }

  const badCredentials = await fetchLoginJson({
    fields: {
      email,
      password: 'wrong-password',
    },
    headers: {
      'x-forwarded-for': '127.0.0.224',
      'x-real-ip': '127.0.0.224',
    },
    allowFailure: true,
  })
  if (!usesSvelteKitActions) {
    assert.equal(badCredentials.response.status, 422)
  }
  assertAuthFieldFailure(badCredentials, ['email', 'password'])

  let throttledLogin
  const throttledEmail = `${appName}-throttled-login-${Date.now()}@app.test`
  for (let attempt = 0; attempt < 6; attempt += 1) {
    throttledLogin = await fetchLoginJson({
      fields: {
        email: throttledEmail,
        password: 'wrong-password',
      },
      headers: {
        'x-forwarded-for': throttleLoginIp,
        'x-real-ip': throttleLoginIp,
      },
      allowFailure: true,
    })
  }
  assertAuthThrottleFailure(throttledLogin)

  let throttledRegister
  for (let attempt = 0; attempt < 11; attempt += 1) {
    throttledRegister = await fetchRegisterJson({
      fields: {
        name: 'No',
        email: 'not-an-email',
        password: 'short',
        passwordConfirmation: 'different',
      },
      headers: {
        'x-forwarded-for': throttleRegisterIp,
        'x-real-ip': throttleRegisterIp,
      },
      allowFailure: true,
    })
  }
  assertAuthThrottleFailure(throttledRegister)

  const loggedInVerificationEmail = `${appName}-logged-in-verification-${Date.now()}@app.test`
  const loggedInVerificationOutputStart = getOutput().length
  const loggedInVerificationJar = createCookieJar()
  const loggedInVerification = await fetchRegisterJson({
    fields: {
      name: 'Logged In Verification User',
      email: loggedInVerificationEmail,
      password,
      passwordConfirmation: password,
    },
    headers: {
      'x-forwarded-for': '127.0.0.221',
      'x-real-ip': '127.0.0.221',
    },
    jar: loggedInVerificationJar,
  })
  if (!usesSvelteKitActions) {
    assert.equal(loggedInVerification.response.status, 201)
  }
  assert.equal(loggedInVerification.json.ok, true)

  const loggedInVerificationToken = (
    await waitForOutputMatch(
      getOutput,
      authTokenPattern,
      loggedInVerificationOutputStart,
    )
  )[1]
  assert.ok(loggedInVerificationToken)

  const loggedInVerified = await fetchAuthJson('/api/verify-email', {
    method: 'POST',
    fields: {
      token: loggedInVerificationToken,
    },
    jar: loggedInVerificationJar,
  })
  assert.equal(loggedInVerified.json.ok, true)
  assert.equal(loggedInVerified.json.data?.redirectTo, '/admin')

  const registerOutputStart = getOutput().length
  const registeredJar = createCookieJar()
  const registered = await fetchRegisterJson({
    fields: {
      name: 'Auth Flow User',
      email,
      password,
      passwordConfirmation: password,
    },
    jar: registeredJar,
  })
  if (!usesSvelteKitActions) {
    assert.equal(registered.response.status, 201)
  }
  assert.equal(registered.json.ok, true)
  if (!usesSvelteKitActions) {
    assert.equal(registered.json.data?.message, 'Account created. Check your inbox to verify your email address.')
  }
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

  const invalidVerification = await fetchAuthJson('/api/verify-email', {
    method: 'POST',
    fields: {
      token: `${verificationToken.split('.', 1)[0]}.wrong-secret`,
    },
    allowFailure: true,
  })
  assert.equal(invalidVerification.response.status, 422)
  assertFieldFailure(invalidVerification, ['token'])

  const duplicateRegistration = await fetchRegisterJson({
    fields: {
      name: 'Duplicate Auth Flow User',
      email,
      password,
      passwordConfirmation: password,
    },
    headers: {
      'x-forwarded-for': '127.0.0.225',
      'x-real-ip': '127.0.0.225',
    },
    allowFailure: true,
  })
  if (!usesSvelteKitActions) {
    assert.equal(duplicateRegistration.response.status, 422)
  }
  assertAuthFieldFailure(duplicateRegistration, ['email'])

  const pendingVerificationJar = createCookieJar()
  const unverifiedLogin = await fetchLoginJson({
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

  if (checkPages) {
    const verifyTokenPage = await fetchAuthText(
      `/verify-email?token=${encodeURIComponent(resentVerificationToken)}`,
    )
    assert.match(verifyTokenPage.text, /Verify your email/i)
  }

  const verified = await fetchAuthJson('/api/verify-email', {
    method: 'POST',
    fields: {
      token: resentVerificationToken,
    },
  })
  assert.equal(verified.json.ok, true)
  assert.equal(verified.json.data?.redirectTo, '/login')

  const alreadyVerifiedResend = await fetchAuthJson('/api/verify-email/resend', {
    method: 'POST',
    fields: {
      email,
    },
    headers: {
      'x-forwarded-for': '127.0.0.226',
      'x-real-ip': '127.0.0.226',
    },
    allowFailure: true,
  })
  assert.equal(alreadyVerifiedResend.response.status, 409)
  assertFieldFailure(alreadyVerifiedResend, ['_root'])

  const consumedVerification = await fetchAuthJson('/api/verify-email', {
    method: 'POST',
    fields: {
      token: resentVerificationToken,
    },
    allowFailure: true,
  })
  assert.equal(consumedVerification.response.status, 422)
  assertFieldFailure(consumedVerification, ['token'])

  const authenticatedJar = createCookieJar()
  const loggedIn = await fetchLoginJson({
    fields: {
      email,
      password,
    },
    jar: authenticatedJar,
  })
  assert.equal(loggedIn.json.ok, true)
  if (!usesSvelteKitActions) {
    assert.equal(loggedIn.json.data?.message, 'Signed in successfully.')
  }
  assert.equal(loggedIn.json.data?.redirectTo, '/admin')
  assert.ok(listSetCookieHeaders(loggedIn.response).length > 0)

  const authenticatedUser = await fetchAuthJson('/api/auth/user', {
    jar: authenticatedJar,
  })
  assert.equal(authenticatedUser.json.authenticated, true)
  assert.equal(authenticatedUser.json.guard, 'web')
  assert.equal(authenticatedUser.json.user?.email, email)
  assert.equal(authenticatedUser.json.user?.name, 'Auth Flow User')

  if (checkPages) {
    const authenticatedHome = await fetchAuthText('/', {
      jar: authenticatedJar,
    })
    assertUserNav(authenticatedHome.text)

    for (const guestPath of ['/login', '/register', '/forgot-password', '/reset-password']) {
      assertRedirectsTo(await fetchAuthText(guestPath, {
        jar: authenticatedJar,
        allowFailure: true,
      }), '/admin')
    }

    const adminPostsPage = await fetchAuthText('/admin/posts', {
      jar: authenticatedJar,
    })
    assert.match(adminPostsPage.text, /Designing the Example App Roadmap/i)

    assertRedirectsTo(await fetchAuthText('/super-admin', {
      jar: authenticatedJar,
      allowFailure: true,
    }), '/super-admin/login')
  }

  const regularAdminLogin = await fetchSuperAdminLoginJson({
    fields: {
      email: 'admin@example.com',
      password: 'admin-secret',
    },
    headers: {
      'x-forwarded-for': '127.0.0.227',
      'x-real-ip': '127.0.0.227',
    },
    allowFailure: true,
  })
  if (!usesSvelteKitActions) {
    assert.equal(regularAdminLogin.response.status, 422)
  }
  assert.equal(regularAdminLogin.json.ok, false)
  assertAuthFieldFailure(regularAdminLogin, ['email'])

  const adminJar = createCookieJar()
  const adminLogin = await fetchSuperAdminLoginJson({
    fields: {
      email: 'super-admin@example.com',
      password: 'admin-secret',
    },
    headers: {
      'x-forwarded-for': '127.0.0.226',
      'x-real-ip': '127.0.0.226',
    },
    jar: adminJar,
  })
  assert.equal(adminLogin.json.ok, true)
  assert.equal(adminLogin.json.data?.redirectTo, '/super-admin')
  assert.ok(listSetCookieHeaders(adminLogin.response).length > 0)

  const superAdminGuardUser = await fetchAuthJson('/api/auth/user?guard=admin', {
    jar: adminJar,
  })
  assert.equal(superAdminGuardUser.json.authenticated, true)
  assert.equal(superAdminGuardUser.json.guard, 'admin')
  assert.equal(superAdminGuardUser.json.user?.email, 'super-admin@example.com')
  assert.equal(superAdminGuardUser.json.user?.name, 'Super Admin')

  const adminDefaultGuardUser = await fetchAuthJson('/api/auth/user', {
    jar: adminJar,
  })
  assert.equal(adminDefaultGuardUser.json.authenticated, false)
  assert.equal(adminDefaultGuardUser.json.guard, 'web')
  assert.equal(adminDefaultGuardUser.json.user, null)

  if (checkPages) {
    const superAdminPage = await fetchAuthText('/super-admin', {
      jar: adminJar,
    })
    assert.match(superAdminPage.text, /Super Admin/i)
    assert.match(superAdminPage.text, /admin guard/i)
    assert.match(superAdminPage.text, /Sign out of super admin/i)

    assertRedirectsTo(await fetchAuthText('/super-admin/login', {
      jar: adminJar,
      allowFailure: true,
    }), '/super-admin')
  }

  const adminLogout = await fetchAuthJson('/api/super-admin/logout', {
    method: 'POST',
    jar: adminJar,
  })
  assert.equal(adminLogout.json.ok, true)
  assert.equal(adminLogout.json.authenticated, false)
  assert.equal(adminLogout.json.message, 'Signed out of super admin.')
  assert.equal(adminLogout.json.user, null)
  assert.ok(listSetCookieHeaders(adminLogout.response).length > 0)

  const adminAfterLogout = await fetchAuthJson('/api/auth/user?guard=admin', {
    jar: adminJar,
  })
  assert.equal(adminAfterLogout.json.authenticated, false)
  assert.equal(adminAfterLogout.json.guard, 'admin')
  assert.equal(adminAfterLogout.json.user, null)

  if (checkPages) {
    assertRedirectsTo(await fetchAuthText('/super-admin', {
      jar: adminJar,
      allowFailure: true,
    }), '/super-admin/login')
  }

  const authenticatedSessionCookie = authenticatedJar.header()
  assert.ok(authenticatedSessionCookie.length > 0)
  assert.match(authenticatedSessionCookie, new RegExp(`(?:^|;\\s*)${escapeRegExp(sessionCookieName)}=`))

  const rememberCookieName = `${sessionCookieName}_remember`
  const rememberedJar = createCookieJar()
  const rememberedLogin = await fetchLoginJson({
    fields: {
      email,
      password,
      remember: true,
    },
    headers: {
      'x-forwarded-for': '127.0.0.222',
      'x-real-ip': '127.0.0.222',
    },
    jar: rememberedJar,
  })
  assert.equal(rememberedLogin.json.ok, true)
  assert.equal(rememberedLogin.json.data?.redirectTo, '/admin')
  assert.ok(listSetCookieHeaders(rememberedLogin.response).some(cookie => cookie.startsWith(`${rememberCookieName}=`)))

  const rememberOnlyCookie = rememberedJar.headerExcept([sessionCookieName])
  assert.match(rememberOnlyCookie, new RegExp(`(?:^|;\\s*)${escapeRegExp(rememberCookieName)}=`))

  const rememberedUser = await fetchAuthJson('/api/auth/user', {
    headers: {
      cookie: rememberOnlyCookie,
    },
  })
  assert.equal(rememberedUser.json.authenticated, true)
  assert.equal(rememberedUser.json.guard, 'web')
  assert.equal(rememberedUser.json.user?.email, email)

  const optOutLogin = await fetchLoginJson({
    fields: {
      email,
      password,
    },
    headers: {
      'x-forwarded-for': '127.0.0.223',
      'x-real-ip': '127.0.0.223',
    },
    jar: rememberedJar,
  })
  assert.equal(optOutLogin.json.ok, true)
  if (!usesSvelteKitActions) {
    assert.ok(listSetCookieHeaders(optOutLogin.response).some(cookie => cookie.startsWith(`${rememberCookieName}=;`)))
    assert.doesNotMatch(rememberedJar.header(), new RegExp(`(?:^|;\\s*)${escapeRegExp(rememberCookieName)}=`))
  }

  const staleRememberUser = await fetchAuthJson('/api/auth/user', {
    headers: {
      cookie: rememberOnlyCookie,
    },
  })
  if (!usesSvelteKitActions) {
    assert.equal(staleRememberUser.json.authenticated, false)
    assert.equal(staleRememberUser.json.user, null)
  }
  assert.equal(staleRememberUser.json.guard, 'web')

  const loggedOut = await fetchAuthJson('/api/logout', {
    method: 'POST',
    jar: authenticatedJar,
  })
  assert.equal(loggedOut.json.ok, true)
  assert.equal(loggedOut.json.authenticated, false)
  assert.equal(loggedOut.json.message, 'Signed out successfully.')
  assert.equal(loggedOut.json.user, null)
  assert.ok(listSetCookieHeaders(loggedOut.response).length > 0)

  const userAfterLogout = await fetchAuthJson('/api/auth/user', {
    jar: authenticatedJar,
  })
  assert.equal(userAfterLogout.json.authenticated, false)
  assert.equal(userAfterLogout.json.guard, 'web')
  assert.equal(userAfterLogout.json.user, null)

  const staleSessionUser = await fetchAuthJson('/api/auth/user', {
    headers: {
      cookie: authenticatedSessionCookie,
    },
  })
  assert.equal(staleSessionUser.json.authenticated, false)
  assert.equal(staleSessionUser.json.guard, 'web')
  assert.equal(staleSessionUser.json.user, null)

  if (checkPages) {
    const loggedOutHome = await fetchAuthText('/', {
      jar: authenticatedJar,
    })
    assertGuestNav(loggedOutHome.text)
  }

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

  const invalidReset = await fetchAuthJson('/api/reset-password', {
    fields: {
      token: 'bad-token',
      password: nextPassword,
      passwordConfirmation: nextPassword,
    },
    allowFailure: true,
  })
  assert.equal(invalidReset.response.status, 422)
  assertFieldFailure(invalidReset, ['token'])

  if (checkPages) {
    const resetPage = await fetchAuthText(`/reset-password?token=${encodeURIComponent(resetToken)}`)
    assert.match(resetPage.text, /Reset password/i)
  }

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

  const consumedReset = await fetchAuthJson('/api/reset-password', {
    fields: {
      token: resetToken,
      password: nextPassword,
      passwordConfirmation: nextPassword,
    },
    allowFailure: true,
  })
  assert.equal(consumedReset.response.status, 422)
  assertFieldFailure(consumedReset, ['token'])

  const oldPasswordLogin = await fetchLoginJson({
    fields: {
      email,
      password,
    },
    allowFailure: true,
  })
  assert.equal(oldPasswordLogin.json.ok, false)

  const refreshedJar = createCookieJar()
  const newPasswordLogin = await fetchLoginJson({
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
