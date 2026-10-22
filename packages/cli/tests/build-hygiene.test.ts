import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(import.meta.dirname, '..')
const generatedCatalog = join(packageRoot, 'src/generated/workspaceCatalog.ts')
const buildRoots: string[] = []

afterAll(async () => {
  await Promise.all(buildRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('builds the CLI without rewriting its generated workspace catalog', async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), 'holo-cli-build-hygiene-'))
  buildRoots.push(buildRoot)
  const before = await stat(generatedCatalog)
  const contentBefore = await readFile(generatedCatalog, 'utf8')

  await execFileAsync('bun', ['run', 'build'], {
    cwd: packageRoot,
    env: { ...process.env, HOLO_BUILD_OUT_DIR: join(buildRoot, 'dist') },
    timeout: 120_000,
  })

  const after = await stat(generatedCatalog)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(generatedCatalog, 'utf8')).toBe(contentBefore)
}, 120_000)
