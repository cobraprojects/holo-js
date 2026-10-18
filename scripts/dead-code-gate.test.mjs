import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

test('dead-code gate permits existing findings but rejects replacement orphans', { timeout: 60000 }, async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-dead-code-'))
  try {
    await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir')
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    await writeFile(join(checkout, 'package.json'), JSON.stringify({
      name: 'dead-code-fixture', main: 'src/index.ts',
      scripts: { 'check:dead-code': manifest.scripts['check:dead-code'] },
    }))
    await mkdir(join(checkout, 'src'))
    await writeFile(join(checkout, 'src/index.ts'), 'export const title = "Post"\n')
    await writeFile(join(checkout, 'src/old-orphan.ts'), 'export const oldTitle = "Draft"\n')

    async function run(args) {
      return execFileAsync('bun', args, { cwd: checkout, maxBuffer: 4 * 1024 * 1024 })
        .then(value => ({ ...value, code: 0 }), error => error)
    }

    await run(['run', 'check:dead-code', '--save-baseline', 'fallow-baseline.json'])
    const existing = await run(['run', 'check:dead-code'])
    assert.equal(existing.code, 0, `${existing.stdout}\n${existing.stderr}`)

    await rm(join(checkout, 'src/old-orphan.ts'))
    await writeFile(join(checkout, 'src/new-orphan.ts'), 'export const newTitle = "Draft"\n')
    const replacement = await run(['run', 'check:dead-code'])
    assert.equal(replacement.code, 1, `${replacement.stdout}\n${replacement.stderr}`)
    assert.match(replacement.stdout, /new-orphan\.ts/)

    await rm(join(checkout, 'src/new-orphan.ts'))
    const cleaned = await run(['run', 'check:dead-code'])
    assert.equal(cleaned.code, 0, `${cleaned.stdout}\n${cleaned.stderr}`)
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})
