import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')

test('published forms without the optional security package', { concurrency: 2 }, async suite => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-native-forms-packages-'))
  try {
    for (const name of ['forms', 'validation', 'kernel']) {
      const target = join(directory, 'node_modules', '@holo-js', name)
      await mkdir(target, { recursive: true })
      await cp(join(root, 'packages', name, 'dist'), join(target, 'dist'), { recursive: true })
      await cp(join(root, 'packages', name, 'package.json'), join(target, 'package.json'))
    }
    const require = createRequire(join(root, 'packages/validation/package.json'))
    await symlink(resolve(dirname(require.resolve('valibot')), '..'), join(directory, 'node_modules', 'valibot'))
    const run = source => {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: directory, encoding: 'utf8' })
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    }
    await Promise.all([
      suite.test('validates real user input without installing security', () => run(`
import assert from 'node:assert/strict'
import { validate, safeParse } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
const definition = schema({ email: field.string().required().email() })
assert.deepEqual(await validate({ email: 'ava@example.com' }, definition), { email: 'ava@example.com' })
const failure = await safeParse({ email: 'invalid' }, definition)
assert.equal(failure.valid, false)
assert.equal(failure.fail().status, 422)
assert.ok(failure.errors.first('email'))
`)),
      suite.test('reports the missing optional package when an app enables throttling', () => run(`
import assert from 'node:assert/strict'
import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
const request = new Request('https://app.test/contact', { method: 'POST', body: new URLSearchParams({ email: 'ava@example.com' }) })
await assert.rejects(validate(request, schema({ email: field.string().required().email() }), { throttle: 'contact' }), /@holo-js\\/security/)
`)),
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
