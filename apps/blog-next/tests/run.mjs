import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SESSION_COOKIE_NAME } from '@holo-js/config'
import ts from 'typescript'
import { assertExampleAppAuthFlow } from '../../../tests/example-app-auth-flow.mjs'
import { assertExampleAppTokenAuthFlow } from '../../../tests/example-app-token-auth-flow.mjs'

const cwd = process.cwd()
const configPath = join(cwd, 'config/app.ts')
const port = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Could not determine an available port.'))
      return
    }

    const selected = String(address.port)
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve(selected)
    })
  })
})
const healthUrl = `http://localhost:${port}/api/holo/health`
const originalConfig = await readFile(configPath, 'utf8')
const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
let capturedOutput = ''

function getJsxTagName(tagName) {
  if (ts.isIdentifier(tagName)) {
    return tagName.text
  }

  if (ts.isPropertyAccessExpression(tagName)) {
    return tagName.name.text
  }

  return tagName.getText()
}

function isJsxNodeNamed(node, tagName) {
  if (ts.isJsxElement(node)) {
    return getJsxTagName(node.openingElement.tagName) === tagName
  }

  return ts.isJsxSelfClosingElement(node) && getJsxTagName(node.tagName) === tagName
}

function findJsxElement(node, tagName) {
  if (ts.isJsxElement(node) && getJsxTagName(node.openingElement.tagName) === tagName) {
    return node
  }

  return ts.forEachChild(node, child => findJsxElement(child, tagName))
}

function containsJsxNode(node, tagName) {
  if (isJsxNodeNamed(node, tagName)) {
    return true
  }

  return ts.forEachChild(node, child => containsJsxNode(child, tagName)) === true
}

function containsRouterReplaceHome(node) {
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'replace'
    && node.arguments.some(argument => ts.isStringLiteral(argument) && argument.text === '/')
  ) {
    return true
  }

  return ts.forEachChild(node, containsRouterReplaceHome) === true
}

async function assertRootLayoutSharesAuthProviderState() {
  const layoutSource = await readFile(join(cwd, 'app/layout.tsx'), 'utf8')
  const sourceFile = ts.createSourceFile('layout.tsx', layoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const authProvider = findJsxElement(sourceFile, 'AuthProvider')

  assert.ok(authProvider, 'Expected app/layout.tsx to render AuthProvider.')
  assert.ok(
    containsJsxNode(authProvider, 'AuthNav'),
    'Expected AuthProvider to contain AuthNav.',
  )
  assert.ok(
    containsJsxNode(authProvider, 'main'),
    'Expected AuthProvider to wrap the routed page content so login refreshes update the header.',
  )
}

async function assertHeaderLogoutRedirectsHome() {
  const authNavSource = await readFile(join(cwd, 'app/auth-nav.tsx'), 'utf8')
  const sourceFile = ts.createSourceFile('auth-nav.tsx', authNavSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  assert.ok(
    containsRouterReplaceHome(sourceFile),
    'Expected header logout to redirect home after clearing the session.',
  )
}

function createChildEnv(overrides = {}) {
  const env = {
    ...process.env,
    APP_NAME: '',
    HOLO_SECURITY_TRUST_PROXY: 'true',
    ...overrides,
  }

  if (existsSync(runtimeSchemaPath)) {
    const preload = `--import=${pathToFileURL(runtimeSchemaPath).href}`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload
  }

  return env
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: createChildEnv(),
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`Command failed: ${command} ${args.join(' ')} (${code})`))
    })
  })
}

async function waitForJson(url, predicate, timeoutMs = 30000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const request = get(url, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            body += chunk
          })
          response.on('end', () => {
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(new Error(`Unexpected status ${response.statusCode ?? 'unknown'}`))
              return
            }

            try {
              resolve(JSON.parse(body))
            } catch (error) {
              reject(error)
            }
          })
        })

        request.on('error', reject)
      })

      if (predicate(payload)) {
        return payload
      }
    } catch (error) {
      lastError = error
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function waitForText(url, predicate, timeoutMs = 30000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const request = get(url, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            body += chunk
          })
          response.on('end', () => {
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(new Error(`Unexpected status ${response.statusCode ?? 'unknown'}`))
              return
            }

            resolve(body)
          })
        })

        request.on('error', reject)
      })

      if (predicate(payload)) {
        return payload
      }
    } catch (error) {
      lastError = error
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function waitForRedirect(url, expectedPath, timeoutMs = 30000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(remainingMs, 5000)))
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        const locationPath = new URL(location, url).pathname
        if (locationPath === expectedPath) {
          return
        }

        lastError = new Error(`Unexpected redirect ${response.status} to ${locationPath}`)
      } else {
        lastError = new Error(`Unexpected status ${response.status}`)
      }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url} to redirect to ${expectedPath}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function pipeOutput(stream, target) {
  if (!stream) {
    return
  }

  stream.on('data', chunk => {
    const text = chunk.toString()
    capturedOutput += text
    target.write(text)
  })
}

let child = null

function killChildTree() {
  if (!child || child.exitCode !== null) {
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already exited.
    }
  }
}

try {
  await rm(join(cwd, '.next'), { recursive: true, force: true })
  await assertRootLayoutSharesAuthProviderState()
  await assertHeaderLogoutRedirectsHome()
  await run('npx', ['vitest', '--run', 'tests/api-v1-routes.test.mjs', 'tests/auth-nav.test.mjs', 'tests/forgot-password-route.test.mjs', 'tests/register-page.test.mjs', 'tests/reset-password-page.test.mjs', 'tests/reset-password-route.test.mjs', 'tests/super-admin-logout-button.test.mjs', 'tests/super-admin-login-page.test.mjs', 'tests/super-admin-login-route.test.mjs', 'tests/verify-email-page.test.mjs', '--reporter=json'])
  await run('bun', ['run', 'prepare'])
  await run('bun', ['x', 'holo', 'migrate:fresh', '--seed'])
  await run('npx', ['tsx', 'tests/blog-logic.mjs'])

  child = spawn('bun', ['run', 'dev'], {
    cwd,
    detached: true,
    env: createChildEnv({
      PORT: port,
      HOST: 'localhost',
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  pipeOutput(child.stdout, process.stdout)
  pipeOutput(child.stderr, process.stderr)

  const initial = await waitForJson(healthUrl, payload => payload.ok === true)
  assert.equal(initial.app, 'blog-next')
  await waitForText(`http://localhost:${port}/`, payload => payload.includes('Shipping a Real Holo Blog on Next'))
  await waitForRedirect(`http://localhost:${port}/admin`, '/login')
  await waitForRedirect(`http://localhost:${port}/admin/posts`, '/login')
  await assertExampleAppAuthFlow({
    baseUrl: `http://localhost:${port}`,
    getOutput: () => capturedOutput,
    appName: 'blog-next',
    sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
    loginRequiresCsrf: true,
  })
  await assertExampleAppTokenAuthFlow({
    baseUrl: `http://localhost:${port}`,
    expectedTitle: 'Shipping a Real Holo Blog on Next',
  })

  await writeFile(configPath, originalConfig.replace("name: env('APP_NAME', 'blog-next')", "name: env('APP_NAME', 'blog-next-updated')"))
  const updated = await waitForJson(healthUrl, payload => payload.app === 'blog-next-updated')
  assert.equal(updated.app, 'blog-next-updated')

  killChildTree()
  await new Promise(resolve => child.once('close', resolve))
  child = null

  await run('bun', ['run', 'lint'])
  await run('bun', ['run', 'typecheck'])
  await run('bun', ['run', 'build'])
} finally {
  await writeFile(configPath, originalConfig)
  killChildTree()
  if (child && child.exitCode === null) {
    await new Promise(resolve => child.once('close', resolve))
  }
}
