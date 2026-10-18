import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import ts from 'typescript'

const execFileAsync = promisify(execFile)

async function readAdvisories() {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== '--report') throw new Error('Usage: node scripts/audit-runtime-dependencies.mjs [--report audit.json]')
    return JSON.parse(await readFile(args[1], 'utf8'))
  }
  const result = await execFileAsync('bun', ['audit', '--json'], { maxBuffer: 16 * 1024 * 1024 })
    .catch(error => {
      if (error.code !== 1) throw error
      return error
    })
  return JSON.parse(result.stdout)
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
  const advisories = await readAdvisories()
  if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories)) throw new Error('Invalid advisory report')
  let failures = 0
  for (const [name, findings] of Object.entries(advisories)) {
    if (!Array.isArray(findings)) throw new Error('Invalid advisory report')
    for (const finding of findings) {
      if (!['low', 'moderate', 'high', 'critical', 'info'].includes(finding.severity) || !semver.validRange(finding.vulnerable_versions) || typeof finding.title !== 'string' || typeof finding.url !== 'string') throw new Error('Invalid advisory report')
      for (const version of inventory.get(name) ?? []) {
        if (!semver.satisfies(version, finding.vulnerable_versions, { includePrerelease: true })) continue
        const identity = `${name}@${version}`
        const blocked = runtime.has(identity) && ['high', 'critical'].includes(finding.severity)
        if (blocked) failures++
        console.log(`${blocked ? 'BLOCK' : 'REPORT'} ${identity} (${finding.severity}): ${finding.title} ${finding.url}`)
      }
    }
  }
  console.log(`Published runtime audit: ${failures} blocking advisories.`)
  process.exitCode = failures > 0 ? 1 : 0
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
