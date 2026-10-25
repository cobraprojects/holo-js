import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A development restart stops the server, so a request can find the port closed or lose its connection mid-response.
const restartingConnectionErrors = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])

export async function assertExampleAppDevelopmentReload({ cwd, baseUrl }) {
  const path = join(cwd, '.env.local')
  const original = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const url = `${baseUrl}/api/framework/config`
  const readName = async () => {
    const response = await fetch(url)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).name
  }
  const written = new Set()
  // Only a restarting server (a refused or dropped connection, 504 while it stops, 503 while it starts) or one
  // still serving a name written earlier means the reload is pending; every other answer or error is the failure.
  const readReloadState = async name => {
    let response
    let body
    try {
      response = await fetch(url)
      body = await response.text()
    } catch (error) {
      const reason = `${error.message} (${error.cause?.code ?? error.cause?.message ?? 'no cause'})`
      if (restartingConnectionErrors.has(error.cause?.code)) return `failed while the server restarted: ${reason}`
      throw new Error(`Request to ${url} failed while waiting for the name ${name}: ${reason}`, { cause: error })
    }
    if (response.status === 503) return 'answered 503 while starting'
    // A stopping Nuxt server still accepts requests after its Vite server closed, and Vite answers them this way.
    if (response.status === 504 && response.statusText === 'Outdated Request') return 'answered 504 Outdated Request while stopping'
    assert.equal(response.status, 200, `${url} answered ${response.status} ${response.statusText} while waiting for the name ${name}:\n${body}`)
    let observed
    try {
      observed = JSON.parse(body).name
    } catch (error) {
      throw new Error(`${url} answered something other than the app config while waiting for the name ${name}:\n${body}`, { cause: error })
    }
    if (observed === name) return undefined
    assert.ok(written.has(observed), `${url} answered the name ${JSON.stringify(observed)}, which this reload never wrote, while waiting for ${name}`)
    return `still served the earlier name ${observed}`
  }
  const waitForName = async name => {
    written.add(name)
    const deadline = Date.now() + 45000
    for (;;) {
      const pending = await readReloadState(name)
      if (pending === undefined) return
      assert.ok(Date.now() < deadline, `The running development app must reload its environment and retain its listening port; ${url} last ${pending} while waiting for the name ${name}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const configPath = join(cwd, 'config/app.ts')
  const originalConfig = await readFile(configPath, 'utf8')
  const initial = await readName()
  written.add(initial)
  const first = `holo-dev-first-${randomUUID()}`
  const latest = `holo-dev-latest-${randomUUID()}`
  let failure
  try {
    await writeFile(path, `${original ?? ''}\nAPP_NAME=${first}\n`)
    await waitForName(first)
    written.add('intermediate')
    await writeFile(path, `${original ?? ''}\nAPP_NAME=intermediate\n`)
    await writeFile(path, `${original ?? ''}\nAPP_NAME=${latest}\n`)
    await waitForName(latest)
    const configured = `holo-dev-config-${randomUUID()}`
    const changedConfig = originalConfig.replace(/name: env\('APP_NAME', '[^']+'\)/, `name: '${configured}'`)
    assert.notEqual(changedConfig, originalConfig)
    await writeFile(configPath, changedConfig)
    await waitForName(configured)
  } catch (error) {
    failure = error
  }
  await writeFile(configPath, originalConfig)
  if (original === undefined) await rm(path, { force: true })
  else await writeFile(path, original)
  // A failed reload is the error to report; waiting for the restored name would only replace it.
  if (failure) throw failure
  await waitForName(initial)
}
