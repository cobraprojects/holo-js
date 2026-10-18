import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('overlapping test typechecks retain their own configurations and both succeed', { timeout: 60000 }, async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-typecheck-overlap-'))
  const children = []
  try {
    await symlink(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir')
    for (let index = 0; index < 5; index++) {
      const directory = join(checkout, 'packages', `library-${index}`)
      await mkdir(join(directory, 'tests'), { recursive: true })
      await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
      }))
      await writeFile(join(directory, 'tests', 'record.ts'), 'export const title: string = "Post"\n')
    }

    function start() {
      const child = spawn(process.execPath, [join(root, 'scripts/run-test-typecheck.mjs')], {
        cwd: checkout,
        env: { ...process.env, HOLO_TYPECHECK_CONCURRENCY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      let output = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { output += chunk })
      const done = once(child, 'close').then(([code]) => ({ code, output }))
      return { child, done }
    }

    const first = start()
    await once(first.child.stdout, 'data')
    const second = start()
    const results = await Promise.all([first.done, second.done])
    for (const result of results) assert.equal(result.code, 0, result.output)
    assert.deepEqual((await readdir(checkout)).filter(name => name.startsWith('.holo-test-typecheck-')), [])
  } finally {
    for (const child of children) child.kill()
    await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'close')))
    await rm(checkout, { recursive: true, force: true })
  }
})
