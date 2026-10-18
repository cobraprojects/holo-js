import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const script = resolve(import.meta.dirname, 'audit-runtime-dependencies.mjs')

for (const [name, runtimeVersion, severity, expectedCode] of [
  ['blocks a high advisory reachable through a published runtime dependency', '1.0.0', 'high', 1],
  ['reports vulnerable tooling without blocking a patched runtime version', '2.0.0', 'critical', 0],
  ['reports moderate runtime advisories without blocking', '1.0.0', 'moderate', 0],
]) {
  test(name, async () => {
    const checkout = await mkdtemp(join(tmpdir(), 'holo-audit-'))
    try {
      await mkdir(join(checkout, 'packages', 'library'), { recursive: true })
      await writeFile(join(checkout, 'packages', 'library', 'package.json'), JSON.stringify({
        name: '@holo-js/library', dependencies: { transport: '*' }, devDependencies: { tool: '*' },
      }))
      await writeFile(join(checkout, 'bun.lock'), JSON.stringify({
        lockfileVersion: 1,
        packages: {
          transport: ['transport@1.0.0', '', { dependencies: { parser: '*' } }],
          'transport/parser': [`parser@${runtimeVersion}`, '', {}],
          parser: ['parser@1.0.0', '', {}],
          tool: ['tool@1.0.0', '', { dependencies: { parser: '*' } }],
        },
      }))
      await writeFile(join(checkout, 'audit.json'), JSON.stringify({
        parser: [{ severity, vulnerable_versions: '<2.0.0', title: 'Parser vulnerability', url: 'https://example.test/advisory' }],
      }))
      const result = await execFileAsync(process.execPath, [script, '--report', 'audit.json'], { cwd: checkout })
        .then(value => ({ ...value, code: 0 }), error => error)
      assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /Parser vulnerability/)
      assert.match(result.stdout, expectedCode === 1 ? /BLOCK.*parser@1\.0\.0/ : /REPORT.*parser@1\.0\.0/)
    } finally {
      await rm(checkout, { recursive: true, force: true })
    }
  })
}

test('invalid advisory input fails closed', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-audit-invalid-'))
  try {
    await mkdir(join(checkout, 'packages'), { recursive: true })
    await writeFile(join(checkout, 'bun.lock'), '{"lockfileVersion":1,"packages":{}}')
    await writeFile(join(checkout, 'audit.json'), '{"error":"registry unavailable"}')
    const result = await execFileAsync(process.execPath, [script, '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Invalid advisory report/)
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})
