import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SESSION_COOKIE_NAME } from '@holo-js/config'
import { assertExampleAppAuthFlow } from '../../../tests/example-app-auth-flow.mjs'

const cwd = process.cwd()
const configPath = join(cwd, 'config/app.ts')
const originalConfig = await readFile(configPath, 'utf8')
const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
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
let capturedOutput = ''

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

function pipeOutput(stream, target, onLine) {
  if (!stream) {
    return
  }

  let buffered = ''
  stream.on('data', chunk => {
    const text = chunk.toString()
    capturedOutput += text
    buffered += text
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      onLine?.(line)
      target.write(`${line}\n`)
    }
  })

  stream.on('end', () => {
    if (buffered.length === 0) {
      return
    }

    onLine?.(buffered)
    target.write(buffered)
  })
}

function waitForDevUrl(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let localUrl

    const finish = (callback) => (value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      child.off('close', onClose)
      callback(value)
    }

    const succeed = finish(resolve)
    const fail = finish(reject)

    const onLine = (line) => {
      const match = line.match(/Local:\s+(https?:\/\/[^\s/]+(?::\d+)?)/)
      if (match) {
        localUrl = match[1]
        succeed(localUrl)
      }
    }

    const onClose = (code, signal) => {
      fail(new Error(`Dev server exited before reporting a local URL (${code ?? signal ?? 'unknown'})`))
    }

    const timeout = setTimeout(() => {
      fail(new Error('Timed out waiting for the dev server URL'))
    }, timeoutMs)

    pipeOutput(child.stdout, process.stdout, onLine)
    pipeOutput(child.stderr, process.stderr, onLine)
    child.once('close', onClose)
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
  await rm(join(cwd, '.svelte-kit'), { recursive: true, force: true })
  await rm(join(cwd, 'build'), { recursive: true, force: true })
  await run('bun', ['run', 'prepare'])
  await run('bun', ['x', 'holo', 'migrate:fresh', '--seed'])
  await run('npx', ['tsx', 'tests/blog-logic.mjs'])

  child = spawn('bun', ['x', 'vite', 'dev', '--host', 'localhost', '--port', port], {
    cwd,
    detached: true,
    env: createChildEnv({
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  const devUrl = await waitForDevUrl(child)
  const healthUrl = `${devUrl}/api/holo`
  const initial = await waitForJson(healthUrl, payload => payload.ok === true)
  assert.equal(initial.app, 'blog-sveltekit')
  await waitForText(`${devUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on SvelteKit'))
  await waitForRedirect(`${devUrl}/admin/posts`, '/login')
  await assertExampleAppAuthFlow({
    baseUrl: devUrl,
    getOutput: () => capturedOutput,
    appName: 'blog-sveltekit',
    sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
  })

  await writeFile(configPath, originalConfig.replace("name: env('APP_NAME', 'blog-sveltekit')", "name: env('APP_NAME', 'blog-sveltekit-updated')"))
  await new Promise(resolve => setTimeout(resolve, 3000))
  const updated = await waitForJson(healthUrl, payload => payload.app === 'blog-sveltekit-updated')
  assert.equal(updated.app, 'blog-sveltekit-updated')

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
