import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dependencySections = ['dependencies', 'peerDependencies', 'optionalDependencies']
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'])
const concreteDependencyPattern = /^@holo-js\/(?:cache-(?:db|redis)|db-(?:mysql|postgres|sqlite)|queue-redis|storage-s3)$/
const abstractionPackages = new Set(['@holo-js/cache', '@holo-js/db', '@holo-js/queue', '@holo-js/storage'])

function packageDependencies(manifest) {
  return new Set(dependencySections.flatMap(section => Object.keys(manifest[section] ?? {})))
}

function readPackages(repoRoot) {
  const packages = new Map()
  for (const directory of readdirSync(join(repoRoot, 'packages'))) {
    const packageRoot = join(repoRoot, 'packages', directory)
    const manifestPath = join(packageRoot, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    packages.set(manifest.name, { directory, manifest, packageRoot })
  }
  return packages
}

function walkSourceFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walkSourceFiles(path)
    const extension = path.slice(path.lastIndexOf('.'))
    return sourceExtensions.has(extension) ? [path] : []
  })
}

function importedHoloSpecifiers(source) {
  const specifiers = new Set()
  const staticPattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\n]*?\sfrom\s*)?['"](@holo-js\/[^'"]+)['"]/g
  const dynamicPattern = /import\s*\(\s*['"](@holo-js\/[^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(staticPattern)) specifiers.add(match[1])
  for (const match of source.matchAll(dynamicPattern)) specifiers.add(match[1])
  return specifiers
}

function packageNameFromSpecifier(specifier) {
  return specifier.split('/').slice(0, 2).join('/')
}

function exportedSubpaths(manifest) {
  if (!manifest.exports || typeof manifest.exports !== 'object') return new Set(['.'])
  return new Set(Object.keys(manifest.exports))
}

function findCycles(graph) {
  const cycles = new Set()
  const visit = (node, path) => {
    const cycleStart = path.indexOf(node)
    if (cycleStart >= 0) {
      const cycle = [...path.slice(cycleStart), node]
      const body = cycle.slice(0, -1)
      const rotations = body.map((_, index) => [...body.slice(index), ...body.slice(0, index), body[index]].join(' -> '))
      cycles.add(rotations.sort()[0])
      return
    }
    for (const dependency of graph.get(node) ?? []) visit(dependency, [...path, node])
  }
  for (const node of graph.keys()) visit(node, [])
  return [...cycles].sort()
}

export function validateArchitecture(repoRoot) {
  const packages = readPackages(repoRoot)
  const failures = []
  const graph = new Map()

  for (const [name, entry] of packages) {
    const dependencies = packageDependencies(entry.manifest)
    graph.set(name, [...dependencies].filter(dependency => packages.has(dependency)))

    if (name === '@holo-js/kernel' && [...dependencies].some(dependency => dependency.startsWith('@holo-js/'))) {
      failures.push('@holo-js/kernel must not depend on another Holo package.')
    }
    if (name === '@holo-js/config') {
      for (const dependency of dependencies) {
        if (dependency.startsWith('@holo-js/') && dependency !== '@holo-js/kernel') {
          failures.push(`@holo-js/config must not depend on feature package ${dependency}.`)
        }
      }
    }
    if (abstractionPackages.has(name)) {
      for (const dependency of dependencies) {
        if (concreteDependencyPattern.test(dependency)) failures.push(`${name} must not depend on concrete package ${dependency}.`)
      }
    }

    for (const file of walkSourceFiles(join(entry.packageRoot, 'src'))) {
      const source = readFileSync(file, 'utf8')
      if (name === '@holo-js/config') {
        for (const specifier of importedHoloSpecifiers(source)) {
          const importedPackage = packageNameFromSpecifier(specifier)
          if (importedPackage !== '@holo-js/config' && importedPackage !== '@holo-js/kernel') {
            failures.push(`${relative(repoRoot, file)} imports feature package ${importedPackage}.`)
          }
        }
      }
      if (abstractionPackages.has(name)) {
        for (const concretePackage of source.match(/@holo-js\/(?:db-(?:mysql|postgres|sqlite)|queue-redis|storage-s3)/g) ?? []) {
          failures.push(`${relative(repoRoot, file)} references concrete package ${concretePackage}.`)
        }
      }
      for (const specifier of importedHoloSpecifiers(source)) {
        const importedPackage = packageNameFromSpecifier(specifier)
        if (importedPackage !== name && !dependencies.has(importedPackage)) {
          failures.push(`${relative(repoRoot, file)} imports undeclared dependency ${importedPackage}.`)
          continue
        }
        const imported = packages.get(importedPackage)
        if (!imported || specifier === importedPackage) continue
        const subpath = `.${specifier.slice(importedPackage.length)}`
        if (!exportedSubpaths(imported.manifest).has(subpath)) {
          failures.push(`${relative(repoRoot, file)} imports non-exported subpath ${specifier}.`)
        }
      }
    }
  }

  for (const cycle of findCycles(graph)) failures.push(`Workspace dependency cycle: ${cycle}.`)
  return failures.sort()
}

export function runArchitectureValidation(repoRoot) {
  const failures = validateArchitecture(repoRoot)
  if (failures.length > 0) throw new Error(`Architecture validation failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runArchitectureValidation(resolve(fileURLToPath(new URL('..', import.meta.url))))
