import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const testFile = /\.test\.(?:[cm]?[jt]sx?)$/
const sourceFile = /\.(?:[cm]?[jt]sx?)$/
const skippedDirectories = new Set(['node_modules', 'dist', '.output', '.nuxt', '.next', '.svelte-kit'])
const realDatabaseMarker = /support\/database['"]|real-database['"]|@holo-js\/db-(?:postgres|mysql)\b|db-(?:postgres|mysql)\/src\b|(?:from\s*|import\s*\(\s*|require\(\s*)['"](?:pg|mysql2(?:\/promise)?)['"]|\bcreate(?:Postgres|MySQL)Adapter\b|\b(?:postgres|mysql)DatabaseDriverFactory\b/
const relativeImport = /(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g
const resolvableExtensions = ['', '.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js', '/index.mjs']
const packageEnvironments = { cli: { HOLO_CLI_INCLUDE_INTEGRATION: '1' } }
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

function walkSourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (skippedDirectories.has(entry)) return []
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walkSourceFiles(path)
    return sourceFile.test(entry) ? [path] : []
  })
}

function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier)
  const sourceBase = base.replace(/\.([cm]?)js$/, '.$1ts')
  return [...resolvableExtensions.map(extension => `${base}${extension}`), sourceBase, `${sourceBase}x`].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

function reachesRealDatabase(file, cache, visiting = new Set()) {
  if (cache.has(file)) return cache.get(file)
  if (visiting.has(file) || file.split(sep).some(part => skippedDirectories.has(part))) return false
  visiting.add(file)
  const source = readFileSync(file, 'utf8')
  const reaches = realDatabaseMarker.test(source) || [...source.matchAll(relativeImport)]
    .map(match => resolveImport(file, match[1]))
    .filter(target => target && target.split(sep).includes('tests'))
    .some(target => reachesRealDatabase(target, cache, visiting))
  visiting.delete(file)
  cache.set(file, reaches)
  return reaches
}

export function realDatabaseGatingTargets(repoRoot) {
  const packagesRoot = join(repoRoot, 'packages')
  if (!existsSync(packagesRoot)) return []
  return readdirSync(packagesRoot).sort().flatMap((entry) => {
    const packageRoot = join(packagesRoot, entry)
    if (!existsSync(join(packageRoot, 'package.json'))) return []
    const cache = new Map()
    const files = walkSourceFiles(join(packageRoot, 'tests'))
      .filter(file => testFile.test(file) && reachesRealDatabase(file, cache))
      .map(file => relative(packageRoot, file).split('\\').join('/'))
      .sort()
    return files.length > 0 ? [{ packageDirectory: `packages/${entry}`, files, environment: packageEnvironments[entry] ?? {} }] : []
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

export function gatingFailures(packageDirectory, report, expectedFiles, exitStatus) {
  if (!report || !Array.isArray(report.testResults)) return [`${packageDirectory}: vitest produced no report`]
  const ranFiles = new Set()
  const failures = report.testResults.flatMap((file) => {
    const relativePath = file.name.split(`/${packageDirectory}/`).at(-1)
    ranFiles.add(relativePath)
    const path = `${packageDirectory}/${relativePath}`
    const failedTests = (file.assertionResults ?? []).filter(result => result.status === 'failed')
    if (failedTests.length > 0) return failedTests.map(result => `${path} :: ${result.fullName}: ${firstLine(result.failureMessages?.[0])}`)
    return file.status === 'failed' ? [`${path}: ${firstLine(file.message) || 'a suite or hook failed'}`] : []
  })
  failures.push(...expectedFiles.filter(file => !ranFiles.has(file)).map(file => `${packageDirectory}/${file}: vitest did not run this file`))
  if (failures.length > 0) return failures
  if (report.success === false) return [`${packageDirectory}: vitest reported a failure`]
  return exitStatus === 0 ? [] : [`${packageDirectory}: vitest exited with status ${exitStatus}, for example after an unhandled rejection`]
}

function runPackage(repoRoot, target) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'holo-real-database-gating-'))
  const outputFile = join(outputDirectory, 'report.json')
  try {
    const result = spawnSync(process.execPath, [join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...target.files, '--reporter=json', `--outputFile=${outputFile}`], {
      cwd: join(repoRoot, target.packageDirectory),
      env: { ...gatingEnvironment(process.env), ...target.environment },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    const report = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, 'utf8')) : undefined
    return gatingFailures(target.packageDirectory, report, target.files, result.status ?? 1)
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
