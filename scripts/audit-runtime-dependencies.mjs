import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import ts from 'typescript'

const execFileAsync = promisify(execFile)

const usage = 'Usage: node scripts/audit-runtime-dependencies.mjs [--all] [--report audit.json]'
const options = process.argv.slice(2)
const blockEveryPackage = options.includes('--all')
const reportArgs = options.filter(arg => arg !== '--all')

async function readAdvisories() {
  if (reportArgs.length > 0) {
    if (reportArgs.length !== 2 || reportArgs[0] !== '--report') throw new Error(usage)
    return JSON.parse(await readFile(reportArgs[1], 'utf8'))
  }
  const result = await execFileAsync('bun', ['audit', '--json'], { maxBuffer: 16 * 1024 * 1024 })
    .then(value => ({ ...value, code: 0 }), error => {
      if (typeof error.code !== 'number') throw error
      return error
    })
  const stderr = result.stderr.trim()
  const describe = message => [message, stderr].filter(Boolean).join('\n')
  // bun audit exits 1 when it finds advisories and 0 when it finds none; anything else is a failed audit.
  if (result.code !== 0 && result.code !== 1) throw new Error(describe(`bun audit --json exited with code ${result.code}.`))
  if (result.stdout.trim() === '') throw new Error(describe(`bun audit --json exited with code ${result.code} without a JSON report.`))
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    throw new Error(describe(`bun audit --json printed an unreadable JSON report (exit code ${result.code}).`))
  }
  if (result.code === 1 && Object.keys(report ?? {}).length === 0) {
    throw new Error(describe('bun audit --json exited with code 1 but reported no advisories.'))
  }
  return report
}

async function readCatalogFloors() {
  const contents = await readFile('package.json', 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}'
    throw error
  })
  const manifest = JSON.parse(contents)
  const catalog = manifest.workspaces?.catalog ?? manifest.catalog ?? {}
  const floors = new Map()
  for (const [name, range] of Object.entries(catalog)) {
    if (!semver.validRange(range)) throw new Error(`Invalid catalog range: ${name}@${range}`)
    floors.set(name, { range, version: semver.minVersion(range).version })
  }
  return floors
}

async function readFloorAdvisories(floors, advisories) {
  if (reportArgs.length > 0) return advisories
  const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries([...floors].map(([name, floor]) => [name, [floor.version]]))),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Advisory lookup failed: ${response.status}`)
  return response.json()
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function readExceptions() {
  const contents = await readFile('audit-exceptions.json', 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '[]'
    throw error
  })
  const exceptions = JSON.parse(contents)
  const isValid = Array.isArray(exceptions) && exceptions.every(exception => (
    typeof exception?.advisory === 'string'
    && typeof exception.package === 'string'
    && semver.valid(exception.version)
    && isCalendarDate(exception.expires)
    && typeof exception.reason === 'string'
    && exception.reason.trim().length > 0
  ))
  if (!isValid) throw new Error('Invalid audit exceptions')
  return exceptions
}

async function main() {
  const parsed = ts.parseConfigFileTextToJson('bun.lock', await readFile('bun.lock', 'utf8'))
  if (parsed.error || parsed.config?.lockfileVersion !== 1 || !parsed.config.packages) throw new Error('Invalid or unsupported bun.lock')
  const packages = parsed.config.packages
  const entries = await readdir('packages', { withFileTypes: true })
  const manifests = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => (
    JSON.parse(await readFile(join('packages', entry.name, 'package.json'), 'utf8'))
  )))
  const workspaces = new Map(manifests.map(manifest => [manifest.name, manifest]))
  const runtime = new Set()
  const visited = new Set()

  function visit(key, metadata) {
    if (visited.has(key)) return
    visited.add(key)
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(metadata[section] ?? {})) {
        const ancestors = key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []
        let resolved
        while (ancestors.length > 0) {
          const candidate = `${ancestors.join('/')}/${name}`
          if (packages[candidate]) {
            resolved = candidate
            break
          }
          ancestors.pop()
        }
        resolved ??= packages[name] ? name : undefined
        if (!resolved) {
          if (section === 'optionalDependencies' || metadata.optionalPeers?.includes(name) || metadata.peerDependenciesMeta?.[name]?.optional) continue
          throw new Error(`Missing locked dependency: ${key} -> ${name}`)
        }
        const [identity, , dependencyMetadata = {}] = packages[resolved]
        if (identity.includes('@workspace:')) {
          const manifest = workspaces.get(name)
          if (!manifest) throw new Error(`Missing workspace manifest: ${name}`)
          visit(resolved, manifest)
        } else {
          runtime.add(identity)
          visit(resolved, dependencyMetadata)
        }
      }
    }
  }

  for (const manifest of manifests) {
    if (!manifest.private) visit(manifest.name, manifest)
  }

  const inventory = new Map()
  for (const [identity] of Object.values(packages)) {
    if (identity.includes('@workspace:')) continue
    const separator = identity.lastIndexOf('@')
    const name = identity.slice(0, separator)
    const versions = inventory.get(name) ?? new Set()
    versions.add(identity.slice(separator + 1))
    inventory.set(name, versions)
  }
  const exceptions = await readExceptions()
  const usedExceptions = new Set()
  const today = new Date().toISOString().slice(0, 10)
  const advisories = await readAdvisories()
  const floors = await readCatalogFloors()
  const floorAdvisories = await readFloorAdvisories(floors, advisories)
  let failures = 0
  function check(name, version, finding, reachable, label) {
    if (!semver.satisfies(version, finding.vulnerable_versions, { includePrerelease: true })) return
    const identity = `${name}@${version}`
    const blocked = blockEveryPackage
      ? ['moderate', 'high', 'critical'].includes(finding.severity)
      : reachable && ['high', 'critical'].includes(finding.severity)
    const exception = blocked
      ? exceptions.find(candidate => candidate.advisory === finding.url && candidate.package === name && candidate.version === version)
      : undefined
    if (exception) {
      usedExceptions.add(exception)
      if (exception.expires >= today) {
        console.log(`EXCEPT ${identity} (${finding.severity})${label}: ${finding.title} ${finding.url} until ${exception.expires}`)
        return
      }
      console.log(`Expired exception for ${identity} ${finding.url} on ${exception.expires}`)
    }
    if (blocked) failures++
    console.log(`${blocked ? 'BLOCK' : 'REPORT'} ${identity} (${finding.severity})${label}: ${finding.title} ${finding.url}`)
  }
  function findingsOf(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Invalid advisory report')
    return Object.entries(report).flatMap(([name, findings]) => {
      if (!Array.isArray(findings)) throw new Error('Invalid advisory report')
      return findings.map(finding => {
        if (!['low', 'moderate', 'high', 'critical', 'info'].includes(finding.severity) || !semver.validRange(finding.vulnerable_versions) || typeof finding.title !== 'string' || typeof finding.url !== 'string') throw new Error('Invalid advisory report')
        return [name, finding]
      })
    })
  }
  for (const [name, finding] of findingsOf(advisories)) {
    for (const version of inventory.get(name) ?? []) check(name, version, finding, runtime.has(`${name}@${version}`), '')
  }
  for (const [name, finding] of findingsOf(floorAdvisories)) {
    const floor = floors.get(name)
    if (floor) check(name, floor.version, finding, true, ` catalog floor ${floor.range}`)
  }
  const isToolingOnly = candidate => inventory.get(candidate.package)?.has(candidate.version) && !runtime.has(`${candidate.package}@${candidate.version}`)
  const checkedExceptions = blockEveryPackage ? exceptions : exceptions.filter(candidate => !isToolingOnly(candidate))
  for (const exception of checkedExceptions.filter(candidate => !usedExceptions.has(candidate))) {
    failures++
    console.log(`Unused exception for ${exception.package}@${exception.version} ${exception.advisory}`)
  }
  console.log(`${blockEveryPackage ? 'Dependency' : 'Published runtime'} audit: ${failures} blocking advisories.`)
  process.exitCode = failures > 0 ? 1 : 0
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
