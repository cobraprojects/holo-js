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

async function runExceptionScenario(exceptions) {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-audit-exception-'))
  try {
    await mkdir(join(checkout, 'packages', 'library'), { recursive: true })
    await writeFile(join(checkout, 'packages', 'library', 'package.json'), JSON.stringify({
      name: '@holo-js/library', dependencies: { parser: '*' },
    }))
    await writeFile(join(checkout, 'bun.lock'), JSON.stringify({
      lockfileVersion: 1,
      packages: { parser: ['parser@1.0.0', '', {}] },
    }))
    await writeFile(join(checkout, 'audit.json'), JSON.stringify({
      parser: [{ severity: 'high', vulnerable_versions: '<=1.0.0', title: 'Parser vulnerability', url: 'https://example.test/advisory' }],
    }))
    await writeFile(join(checkout, 'audit-exceptions.json'), JSON.stringify(exceptions))
    return await execFileAsync(process.execPath, [script, '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
}

const parserException = {
  advisory: 'https://example.test/advisory',
  package: 'parser',
  version: '1.0.0',
  reason: 'No patched release; reachable only through a framework peer.',
}

test('reports an excepted advisory without blocking until the exception expires', async () => {
  const result = await runExceptionScenario([{ ...parserException, expires: '2999-01-01' }])
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /EXCEPT parser@1\.0\.0 \(high\).*until 2999-01-01/)
})

test('blocks an advisory again once its exception has expired', async () => {
  const result = await runExceptionScenario([{ ...parserException, expires: '2000-01-01' }])
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /BLOCK parser@1\.0\.0/)
  assert.match(result.stdout, /Expired exception.*parser@1\.0\.0.*2000-01-01/)
})

test('fails when an exception no longer matches a blocking advisory', async () => {
  const result = await runExceptionScenario([{ ...parserException, version: '0.9.0', expires: '2999-01-01' }])
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /Unused exception.*parser@0\.9\.0/)
})

test('rejects an exception whose expiry is not a real calendar date', async () => {
  const result = await runExceptionScenario([{ ...parserException, expires: '2026-13-17' }])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Invalid audit exceptions/)
})

test('--all blocks moderate advisories in tooling that the published runtime does not reach', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-audit-all-'))
  try {
    await mkdir(join(checkout, 'packages', 'library'), { recursive: true })
    await writeFile(join(checkout, 'packages', 'library', 'package.json'), JSON.stringify({
      name: '@holo-js/library', devDependencies: { tool: '*' },
    }))
    await writeFile(join(checkout, 'bun.lock'), JSON.stringify({
      lockfileVersion: 1,
      packages: {
        tool: ['tool@1.0.0', '', { dependencies: { parser: '*' } }],
        parser: ['parser@1.0.0', '', {}],
      },
    }))
    await writeFile(join(checkout, 'audit.json'), JSON.stringify({
      parser: [{ severity: 'moderate', vulnerable_versions: '<=1.0.0', title: 'Parser vulnerability', url: 'https://example.test/advisory' }],
    }))
    const reported = await execFileAsync(process.execPath, [script, '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
    assert.equal(reported.code, 0, `${reported.stdout}\n${reported.stderr}`)
    const blocked = await execFileAsync(process.execPath, [script, '--all', '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
    assert.equal(blocked.code, 1, `${blocked.stdout}\n${blocked.stderr}`)
    assert.match(blocked.stdout, /BLOCK parser@1\.0\.0 \(moderate\)/)
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})

test('an exception for tooling-only code is enforced only by --all', async () => {
  const checkout = await mkdtemp(join(tmpdir(), 'holo-audit-tooling-'))
  try {
    await mkdir(join(checkout, 'packages', 'library'), { recursive: true })
    await writeFile(join(checkout, 'packages', 'library', 'package.json'), JSON.stringify({
      name: '@holo-js/library', devDependencies: { parser: '*' },
    }))
    await writeFile(join(checkout, 'bun.lock'), JSON.stringify({
      lockfileVersion: 1,
      packages: { parser: ['parser@1.0.0', '', {}] },
    }))
    await writeFile(join(checkout, 'audit.json'), JSON.stringify({}))
    await writeFile(join(checkout, 'audit-exceptions.json'), JSON.stringify([{ ...parserException, expires: '2999-01-01' }]))
    const reported = await execFileAsync(process.execPath, [script, '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
    assert.equal(reported.code, 0, `${reported.stdout}\n${reported.stderr}`)
    const enforced = await execFileAsync(process.execPath, [script, '--all', '--report', 'audit.json'], { cwd: checkout })
      .then(value => ({ ...value, code: 0 }), error => error)
    assert.equal(enforced.code, 1, `${enforced.stdout}\n${enforced.stderr}`)
    assert.match(enforced.stdout, /Unused exception for parser@1\.0\.0/)
  } finally {
    await rm(checkout, { recursive: true, force: true })
  }
})
