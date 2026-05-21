import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from './validate-framework-smoke.mjs'

const repoRoot = join(import.meta.dirname, '..')
const nextAppRoot = join(repoRoot, 'apps/Next_test_app')
const nuxtAppRoot = join(repoRoot, 'apps/Nuxt_test_app')
const svelteKitAppRoot = join(repoRoot, 'apps/svelte_test_app')
const nextMutationRoutePaths = [
  'app/api/holo/audio/route.ts',
  'app/api/holo/broadcast/route.ts',
  'app/api/holo/events/route.ts',
  'app/api/holo/matrix/route.ts',
  'app/api/holo/queue/route.ts',
]
const nuxtMutationRouteNames = [
  'audio',
  'broadcast',
  'events',
  'matrix',
  'queue',
]
const svelteKitMutationRoutePaths = [
  'src/routes/api/holo/audio/+server.ts',
  'src/routes/api/holo/broadcast/+server.ts',
  'src/routes/api/holo/events/+server.ts',
  'src/routes/api/holo/matrix/+server.ts',
  'src/routes/api/holo/queue/+server.ts',
]

test('Next storage smoke route uses the workspace storage package', async () => {
  const route = await readFile(join(nextAppRoot, 'app/storage/[[...path]]/route.ts'), 'utf8')

  assert.match(route, /from '@holo-js\/storage'/)
  assert.doesNotMatch(route, /@\/server\/lib\/public-storage/)
  await assert.rejects(
    readFile(join(nextAppRoot, 'server/lib/public-storage.ts'), 'utf8'),
    { code: 'ENOENT' },
  )
})

test('Next side-effecting smoke API routes are POST-only', async () => {
  for (const routePath of nextMutationRoutePaths) {
    const route = await readFile(join(nextAppRoot, routePath), 'utf8')

    assert.match(route, /export async function POST\(/, `${routePath} should expose POST`)
    assert.doesNotMatch(route, /export async function GET\(/, `${routePath} should not expose GET`)
  }
})

test('Nuxt side-effecting smoke API routes are POST-only', async () => {
  for (const routeName of nuxtMutationRouteNames) {
    const routePath = `server/api/holo/${routeName}.post.ts`
    const route = await readFile(join(nuxtAppRoot, routePath), 'utf8')

    assert.match(route, /defineEventHandler\(/, `${routePath} should expose a handler`)
    await assert.rejects(
      readFile(join(nuxtAppRoot, `server/api/holo/${routeName}.get.ts`), 'utf8'),
      { code: 'ENOENT' },
    )
  }
})

test('SvelteKit side-effecting smoke API routes are POST-only', async () => {
  for (const routePath of svelteKitMutationRoutePaths) {
    const route = await readFile(join(svelteKitAppRoot, routePath), 'utf8')

    assert.match(route, /(?:export async function POST\(|export const POST:)/, `${routePath} should expose POST`)
    assert.doesNotMatch(route, /(?:export async function GET\(|export const GET:)/, `${routePath} should not expose GET`)
  }
})

test('framework smoke runner rejects GET and posts to mutation routes', async () => {
  const runner = await readFile(join(repoRoot, 'scripts/validate-framework-smoke.mjs'), 'utf8')

  assert.match(runner, /function smokeMutationRequest\(\)/)
  assert.match(runner, /return \{ method: 'POST' \}/)
  assert.match(runner, /assert\.equal\(response\.status, 405/)
  assert.match(runner, /fetchJson\(`\$\{baseUrl\}\$\{queuePath\}`, smokeMutationRequest\(\)\)/)
  assert.match(runner, /fetchJson\(`\$\{baseUrl\}\/api\/holo\/events`, smokeMutationRequest\(\)\)/)
  assert.match(runner, /fetchJson\(`\$\{baseUrl\}\/api\/holo\/broadcast`, smokeMutationRequest\(\)\)/)
  assert.match(runner, /fetchJson\(`\$\{baseUrl\}\/api\/holo\/matrix`, smokeMutationRequest\(\)\)/)
  assert.match(runner, /fetchJson\(`\$\{baseUrl\}\/api\/holo\/audio`, smokeMutationRequest\(\)\)/)
})

test('startServer cleans up the child process when readiness fails', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'holo-smoke-server-'))
  const pidPath = join(tempRoot, 'server.pid')

  try {
    await assert.rejects(
      startServer({
        cwd: tempRoot,
        port: 39219,
        start: [
          process.execPath,
          '-e',
          [
            'const fs = require("node:fs")',
            `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
            'setInterval(() => {}, 1000)',
          ].join(';'),
        ],
      }, 100),
      /Timed out waiting for/,
    )

    const pid = Number(await readFile(pidPath, 'utf8'))
    assert.equal(isProcessAlive(pid), false)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
