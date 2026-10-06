import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'

const execute = promisify(execFile)

it('loads one project independently in parallel processes without losing environment values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-config-parallel-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/services.ts'), `
await new Promise(resolve => setTimeout(resolve, 10))
export default { owner: process.env.CONFIG_OWNER }
`)
  const entry = resolve(import.meta.dirname, '../src/index.ts')
  const script = `
import { loadConfigDirectory } from ${JSON.stringify(entry)}
const results = []
for (let index = 0; index < 8; index += 1) {
  const loaded = await loadConfigDirectory(${JSON.stringify(root)}, { preferCache: false, processEnv: { CONFIG_OWNER: process.env.CONFIG_OWNER } })
  results.push(loaded.custom.services.owner)
}
process.stdout.write(JSON.stringify(results))
`
  const worker = join(root, 'worker.ts')
  await writeFile(worker, script)
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const owner = `worker-${index}`
    const { stdout } = await execute('bun', [worker], { env: { ...process.env, VITEST: 'true', CONFIG_OWNER: owner } })
    return { owner, values: JSON.parse(stdout) }
  }))
  for (const result of results) expect(result.values).toEqual(Array.from({ length: 8 }, () => result.owner))
}, 15_000)
