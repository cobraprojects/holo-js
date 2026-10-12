import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function assertExampleAppDevelopmentReload({ cwd, baseUrl }) {
  const path = join(cwd, '.env.local')
  const original = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const readName = async () => {
    const response = await fetch(`${baseUrl}/api/framework/config`)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).name
  }
  const waitForName = async name => {
    const deadline = Date.now() + 45000
    let observed
    while (Date.now() < deadline) {
      observed = await readName().catch(() => undefined)
      if (observed === name) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(observed, name, 'The running development app must reload its environment and retain its listening port')
  }
  const configPath = join(cwd, 'config/app.ts')
  const originalConfig = await readFile(configPath, 'utf8')
  const initial = await readName()
  const first = `holo-dev-first-${randomUUID()}`
  const latest = `holo-dev-latest-${randomUUID()}`
  try {
    await writeFile(path, `${original ?? ''}\nAPP_NAME=${first}\n`)
    await waitForName(first)
    await writeFile(path, `${original ?? ''}\nAPP_NAME=intermediate\n`)
    await writeFile(path, `${original ?? ''}\nAPP_NAME=${latest}\n`)
    await waitForName(latest)
    const configured = `holo-dev-config-${randomUUID()}`
    const changedConfig = originalConfig.replace(/name: env\('APP_NAME', '[^']+'\)/, `name: '${configured}'`)
    assert.notEqual(changedConfig, originalConfig)
    await writeFile(configPath, changedConfig)
    await waitForName(configured)
  } finally {
    await writeFile(configPath, originalConfig)
    if (original === undefined) await rm(path, { force: true })
    else await writeFile(path, original)
    await waitForName(initial)
  }
}
