import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const rootDir = resolve(import.meta.dirname, '..')
const optionalPackages = [
  'storage',
  'events',
  'queue',
  'validation',
  'forms',
  'auth',
  'authorization',
  'notifications',
  'mail',
  'broadcast',
  'realtime',
  'security',
  'cache',
].join(',')
const frameworkJourneys = [
  { framework: 'nuxt', projectName: 'journey-nuxt', port: 4387 },
  { framework: 'next', projectName: 'journey-next', port: 4388 },
  { framework: 'sveltekit', projectName: 'journey-sveltekit', port: 4389 },
]
const scaffoldFeatureDependencies = [
  '@holo-js/auth',
  '@holo-js/authorization',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/events',
  '@holo-js/flux',
  '@holo-js/forms',
  '@holo-js/mail',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/realtime',
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/validation',
]
const scaffoldFeaturePaths = [
  'config/auth.ts',
  'config/broadcast.ts',
  'config/cache.ts',
  'config/cors.ts',
  'config/mail.ts',
  'config/notifications.ts',
  'config/queue.ts',
  'config/security.ts',
  'config/session.ts',
  'config/storage.ts',
  'server/abilities/README.md',
  'server/broadcast',
  'server/channels',
  'server/events',
  'server/jobs',
  'server/listeners',
  'server/mail',
  'server/models/User.ts',
  'server/policies/README.md',
  'server/realtime',
]
const scaffoldMigrationSuffixes = [
  '_create_users.ts',
  '_create_sessions.ts',
  '_create_auth_identities.ts',
  '_create_personal_access_tokens.ts',
  '_create_password_reset_tokens.ts',
  '_create_email_verification_tokens.ts',
  '_create_notifications.ts',
]

function resolveJourneys(argv) {
  const frameworkIndex = argv.indexOf('--framework')
  if (frameworkIndex === -1) return frameworkJourneys

  const requestedFramework = argv[frameworkIndex + 1]
  const journey = frameworkJourneys.find(candidate => candidate.framework === requestedFramework)
  if (!journey) {
    throw new Error(`Unknown framework "${requestedFramework ?? ''}".`)
  }

  return [journey]
}

function log(framework, message) {
  process.stdout.write(`[scaffold-smoke:${framework}] ${message}\n`)
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(framework, command, args, options = {}) {
  log(framework, `${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  })

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }

  return result
}

async function writeProjectFile(projectRoot, relativePath, contents) {
  const target = join(projectRoot, relativePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
}

async function overlayLocalPackages(projectRoot) {
  const entries = await readdir(join(rootDir, 'packages'), { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const sourceRoot = join(rootDir, 'packages', entry.name)
    const manifestPath = join(sourceRoot, 'package.json')
    const distPath = join(sourceRoot, 'dist')
    if (!await pathExists(manifestPath) || !await pathExists(distPath)) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@holo-js/')) continue

    const targetRoot = join(projectRoot, 'node_modules', ...manifest.name.split('/'))
    await rm(targetRoot, { recursive: true, force: true })
    await mkdir(targetRoot, { recursive: true })
    await cp(distPath, join(targetRoot, 'dist'), { recursive: true })
    await cp(manifestPath, join(targetRoot, 'package.json'))
  }
}

async function copyWorkspaceNativeDependencies(projectRoot) {
  for (const packageName of ['better-sqlite3']) {
    const directSource = join(rootDir, 'node_modules', packageName)
    const storedSource = join(rootDir, 'node_modules/.bun/node_modules', packageName)
    const source = await pathExists(directSource) ? directSource : storedSource
    const target = join(projectRoot, 'node_modules', packageName)
    assert.equal(await pathExists(source), true, `Missing workspace dependency ${packageName}.`)
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true, dereference: true })
  }
}

async function createInstallWrapper(tempRoot) {
  const binRoot = join(tempRoot, 'bin')
  const npmPath = join(binRoot, 'npm')
  await mkdir(binRoot, { recursive: true })
  await writeFile(npmPath, [
    '#!/bin/sh',
    'node -e "const fs=require(\'node:fs\');const p=JSON.parse(fs.readFileSync(\'package.json\',\'utf8\'));p.dependencies[\'@holo-js/kernel\']=\'file:\'+process.env.HOLO_KERNEL_ROOT;fs.writeFileSync(\'package.json\',JSON.stringify(p,null,2)+\'\\n\')"',
    '"$HOLO_REAL_NPM" install --ignore-scripts',
    'status=$?',
    'if [ "$status" -eq 0 ]; then node "$HOLO_SMOKE_SCRIPT" --overlay-local-packages "$PWD"; fi',
    'node -e "const fs=require(\'node:fs\');const p=JSON.parse(fs.readFileSync(\'package.json\',\'utf8\'));p.dependencies[\'@holo-js/kernel\']=process.env.HOLO_KERNEL_RANGE;fs.writeFileSync(\'package.json\',JSON.stringify(p,null,2)+\'\\n\')"',
    'exit $status',
    '',
  ].join('\n'), 'utf8')
  await chmod(npmPath, 0o755)
  return binRoot
}

async function assertScaffoldStructure(projectRoot, journey) {
  const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.prepare, 'holo key:generate && holo prepare')
  assert.equal(manifest.scripts.dev, 'holo dev')
  assert.equal(manifest.scripts.build, 'holo build')
  assert.equal(manifest.scripts.start, 'holo start')
  assert.equal(manifest.dependencies['@holo-js/kernel'].startsWith('^'), true)
  for (const dependency of scaffoldFeatureDependencies) {
    assert.equal(typeof manifest.dependencies[dependency], 'string', `Missing scaffold dependency ${dependency}.`)
  }
  for (const path of scaffoldFeaturePaths) {
    assert.equal(await pathExists(join(projectRoot, path)), true, `Missing scaffold feature path ${path}.`)
  }
  assert.equal(await pathExists(join(projectRoot, '.holo-js/framework/project.json')), true)
  assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/schema.generated.ts')), true)
  assert.equal(await pathExists(join(projectRoot, 'eslint.config.mjs')), true)
  assert.equal(await pathExists(join(projectRoot, 'server/holo.ts')), false)
  assert.equal(await pathExists(join(projectRoot, 'src/lib/server/holo.ts')), false)

  const migrations = await readdir(join(projectRoot, 'server/db/migrations'))
  for (const suffix of scaffoldMigrationSuffixes) {
    assert.equal(migrations.some(migration => migration.endsWith(suffix)), true, `Missing scaffold migration ${suffix}.`)
  }

  const env = await readFile(join(projectRoot, '.env'), 'utf8')
  for (const entry of ['BROADCAST_CONNECTION=holo', 'CACHE_PREFIX=', 'MAIL_MAILER=preview', 'SESSION_DRIVER=file']) {
    assert.match(env, new RegExp(`^${entry}`, 'm'))
  }

  if (journey.framework === 'next') {
    assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/next/holo.ts')), true)
    assert.equal(await pathExists(join(projectRoot, 'app/api/auth/user/route.ts')), true)
  }

  if (journey.framework === 'sveltekit') {
    assert.equal(await pathExists(join(projectRoot, '.holo-js/generated/sveltekit/holo.ts')), true)
  }
}

async function assertGeneratedSchema(projectRoot, tableName) {
  const schemaTypeScript = await readFile(join(projectRoot, '.holo-js/generated/schema.generated.ts'), 'utf8')
  const schemaRuntime = await readFile(join(projectRoot, '.holo-js/generated/schema.mjs'), 'utf8')
  assert.match(schemaTypeScript, new RegExp(`defineGeneratedTable\\("${tableName}"`))
  assert.match(schemaRuntime, new RegExp(`defineGeneratedTable\\("${tableName}"`))
}

async function waitForRenderedApp(journey, server) {
  const url = `http://127.0.0.1:${journey.port}`
  const deadline = Date.now() + 45_000
  let lastError

  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Server exited before ${url} responded.`)
    }

    try {
      const response = await fetch(url)
      const body = await response.text()
      if (response.ok) {
        assert.match(body, new RegExp(journey.projectName))
        return
      }
      lastError = new Error(`HTTP ${response.status}: ${body}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function stopServer(server) {
  if (server.exitCode !== null) return

  server.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => server.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])

  if (server.exitCode === null) {
    server.kill('SIGKILL')
  }
}

async function runFrameworkJourney(tempRoot, journey, cliPath, realNpm, localPackageEnv) {
  const projectRoot = join(tempRoot, journey.projectName)
  const scaffold = run(journey.framework, 'node', [
    cliPath,
    'new',
    journey.projectName,
    '--framework',
    journey.framework,
    '--database',
    'sqlite',
    '--package-manager',
    'npm',
    '--package',
    optionalPackages,
  ], {
    cwd: tempRoot,
    env: localPackageEnv,
  })
  assert.match(scaffold.stdout, /Created Holo project:/)
  assert.match(scaffold.stdout, /installed dependencies/)

  await overlayLocalPackages(projectRoot)
  assert.equal(await pathExists(join(projectRoot, 'node_modules/@holo-js/adapter-shared/package.json')), true)
  run(journey.framework, realNpm, ['run', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await assertScaffoldStructure(projectRoot, journey)

  const tableName = `journey_${journey.framework.replace('sveltekit', 'svelte')}_records`
  await writeProjectFile(projectRoot, `server/db/migrations/2026_07_17_000001_create_${tableName}.ts`, `
import { defineMigration } from '@holo-js/db'

export default defineMigration({
  async up({ schema }) {
    await schema.createTable('${tableName}', (table) => {
      table.id()
      table.string('name')
    })
  },
  async down({ schema }) {
    await schema.dropTable('${tableName}')
  },
})
`)

  run(journey.framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await copyWorkspaceNativeDependencies(projectRoot)
  run(journey.framework, 'npx', ['holo', 'migrate', '--force'], { cwd: projectRoot, env: localPackageEnv })
  run(journey.framework, 'npx', ['holo', 'prepare'], { cwd: projectRoot, env: localPackageEnv })
  await copyWorkspaceNativeDependencies(projectRoot)
  await overlayLocalPackages(projectRoot)
  await assertGeneratedSchema(projectRoot, tableName)
  run(journey.framework, realNpm, ['run', 'lint'], { cwd: projectRoot, env: localPackageEnv })
  assert.equal(await pathExists(join(projectRoot, 'node_modules/@holo-js/adapter-shared/package.json')), true)
  run(journey.framework, realNpm, ['run', 'typecheck'], { cwd: projectRoot, env: localPackageEnv })
  run(journey.framework, realNpm, ['run', 'build'], { cwd: projectRoot, env: localPackageEnv })

  const server = spawn(realNpm, ['run', 'start'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...localPackageEnv,
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      PORT: String(journey.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForRenderedApp(journey, server)
  } catch (error) {
    const stdout = server.stdout?.read()?.toString() ?? ''
    const stderr = server.stderr?.read()?.toString() ?? ''
    throw new Error([error instanceof Error ? error.message : String(error), stdout, stderr].filter(Boolean).join('\n'))
  } finally {
    await stopServer(server)
  }

  log(journey.framework, 'passed')
}

const overlayIndex = process.argv.indexOf('--overlay-local-packages')

if (overlayIndex !== -1) {
  const projectRoot = process.argv[overlayIndex + 1]
  assert.equal(typeof projectRoot, 'string')
  await overlayLocalPackages(projectRoot)
  process.exit(0)
}

const tempRoot = await mkdtemp(join(tmpdir(), 'holo-scaffold-user-journey-'))

try {
  log('workspace', tempRoot)
  if (!process.argv.includes('--skip-build')) {
    run('workspace', 'bun', ['run', '--filter', '@holo-js/*', '--sequential', 'build'])
  }
  const realNpm = run('workspace', 'which', ['npm']).stdout.trim()
  const rootManifest = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'))
  const kernelRange = rootManifest.workspaces?.catalog?.['@holo-js/kernel']
  assert.equal(typeof kernelRange, 'string')
  const binRoot = await createInstallWrapper(tempRoot)
  const localPackageEnv = {
    HOLO_KERNEL_RANGE: kernelRange,
    HOLO_KERNEL_ROOT: join(rootDir, 'packages/kernel'),
    HOLO_REAL_NPM: realNpm,
    HOLO_SMOKE_SCRIPT: import.meta.filename,
    PATH: `${binRoot}:${process.env.PATH ?? ''}`,
  }
  const cliPath = join(rootDir, 'packages/cli/dist/bin/holo.mjs')

  for (const journey of resolveJourneys(process.argv.slice(2))) {
    await runFrameworkJourney(tempRoot, journey, cliPath, realNpm, localPackageEnv)
  }

  log('success', 'all scaffold user journeys passed')
} finally {
  if (process.env.HOLO_KEEP_SMOKE_TMP !== '1') {
    await rm(tempRoot, { recursive: true, force: true })
  } else {
    log('workspace', `kept ${tempRoot}`)
  }
}
