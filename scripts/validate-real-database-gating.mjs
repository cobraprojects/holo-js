import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testFile = /\.test\.(?:[cm]?[jt]sx?)$/
const skippedDirectories = new Set(['node_modules', 'dist', '.output', '.nuxt', '.next', '.svelte-kit'])
const realDatabaseMarker = /support\/database['"]|real-database['"]|@holo-js\/db-(?:postgres|mysql)\b|db-(?:postgres|mysql)\/src\b|from\s*['"](?:pg|mysql2(?:\/promise)?)['"]|\bcreate(?:Postgres|MySQL)Adapter\b|\b(?:postgres|mysql)DatabaseDriverFactory\b/
const removedVariables = ['HOLO_POSTGRES_INTEGRATION', 'HOLO_MYSQL_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'HOLO_MYSQL_DATABASE', 'PGDATABASE']
const unreachableServer = {
  HOLO_POSTGRES_HOST: '127.0.0.1',
  HOLO_POSTGRES_PORT: '1',
  HOLO_MYSQL_HOST: '127.0.0.1',
  HOLO_MYSQL_PORT: '1',
  PGHOST: '127.0.0.1',
  PGPORT: '1',
}
const gatingAdvice = 'Every test that reaches PostgreSQL or MySQL must skip when its integration flag is off. Gate it with integrationDrivers(), postgresIntegration or mysqlIntegration from tests/support/real-database.ts, and connect through postgresTestConnection(), mysqlTestConnection() or testConnectionUrl().'

function walkTestFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (skippedDirectories.has(entry)) return []
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walkTestFiles(path)
    return testFile.test(entry) ? [path] : []
  })
}

export function realDatabaseGatingTargets(repoRoot) {
  const packagesRoot = join(repoRoot, 'packages')
  if (!existsSync(packagesRoot)) return []
  return readdirSync(packagesRoot).sort().flatMap((entry) => {
    const packageRoot = join(packagesRoot, entry)
    if (!existsSync(join(packageRoot, 'package.json'))) return []
    const files = walkTestFiles(join(packageRoot, 'tests'))
      .filter(file => realDatabaseMarker.test(readFileSync(file, 'utf8')))
      .map(file => relative(packageRoot, file).split('\\').join('/'))
      .sort()
    return files.length > 0 ? [{ packageDirectory: `packages/${entry}`, files }] : []
  })
}

export function gatingEnvironment(environment) {
  const gated = { ...environment, ...unreachableServer }
  for (const variable of removedVariables) delete gated[variable]
  return gated
}

function firstLine(message) {
  return String(message ?? '').split('\n')[0].trim()
}

export function gatingFailures(packageDirectory, report) {
  if (!report || !Array.isArray(report.testResults)) return [`${packageDirectory}: vitest produced no report`]
  const failures = report.testResults.flatMap((file) => {
    const path = `${packageDirectory}/${file.name.split(`/${packageDirectory}/`).at(-1)}`
    const failedTests = (file.assertionResults ?? []).filter(result => result.status === 'failed')
    if (failedTests.length > 0) return failedTests.map(result => `${path} :: ${result.fullName}: ${firstLine(result.failureMessages?.[0])}`)
    return file.status === 'failed' ? [`${path}: ${firstLine(file.message) || 'a suite or hook failed'}`] : []
  })
  return failures.length === 0 && report.success === false ? [`${packageDirectory}: vitest reported a failure`] : failures
}

function runPackage(repoRoot, target) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'holo-real-database-gating-'))
  const outputFile = join(outputDirectory, 'report.json')
  try {
    spawnSync(process.execPath, [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...target.files, '--reporter=json', `--outputFile=${outputFile}`, '--passWithNoTests'], {
      cwd: join(repoRoot, target.packageDirectory),
      env: gatingEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const report = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, 'utf8')) : undefined
    return gatingFailures(target.packageDirectory, report)
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true })
  }
}

export function runRealDatabaseGatingValidation(repoRoot) {
  const failures = realDatabaseGatingTargets(repoRoot).flatMap(target => runPackage(repoRoot, target))
  if (failures.length > 0) throw new Error(`Real-database gating failed without integration flags:\n${failures.map(failure => `- ${failure}`).join('\n')}\n${gatingAdvice}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runRealDatabaseGatingValidation(resolve(fileURLToPath(new URL('..', import.meta.url))))
