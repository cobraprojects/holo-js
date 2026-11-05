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

const realDatabaseHelpers = 'postgresTestConnection() or mysqlTestConnection() from tests/support/real-database.ts'
const realDatabaseConnectionHelpers = 'postgresTestConnection(), mysqlTestConnection() or testConnectionUrl() from tests/support/real-database.ts'
const realDatabaseGates = 'integrationDrivers(), postgresIntegration or mysqlIntegration from tests/support/real-database.ts'
const realDatabaseAllowedFiles = new Set(['tests/support/real-database.ts', 'tests/native-library-suite.mjs', 'tests/example-app-matrix.mjs'])
const skippedTestDirectories = new Set(['node_modules', 'dist', '.output', '.nuxt', '.next', '.svelte-kit'])
const realDatabaseEnvRead = /process\.env(?:\.|\[\s*['"`])(HOLO_(?:POSTGRES|MYSQL|\$\{[^}]+\})_(?:HOST|PORT|USER|PASSWORD|DATABASE|URL))\b/g
const systemDatabaseName = /(?:database|DATABASE)[^\n]*?\?\?\s*['"](postgres|mysql)['"]|\bdatabase\s*:\s*['"](postgres|mysql)['"]/g
const realConnectionConstructor = /\b(createPostgresAdapter|createMySQLAdapter|postgresDatabaseDriverFactory\.create|mysqlDatabaseDriverFactory\.create|new\s+(?:pg\.)?(?:Client|Pool)|createConnection|createPool)\s*\(/g
const realConnectionSettings = /\b(?:host|port|database|connectionString|url|uri)\s*:|^\(\s*[`'"](?:postgres(?:ql)?|mysql):\/\//
const sharedConnectionHelper = /\b(?:postgresTestConnection|mysqlTestConnection|testConnectionUrl|openDatabase)\b/
const realDatabaseCall = /\bopenDatabase\(\s*(?!['"]sqlite['"]|\))|\b(?:postgresTestConnection|mysqlTestConnection)\(/
const testRegistration = /^(\s*)(?:it|test|describe)((?:\.[A-Za-z]+(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))?)*)\s*\(/
const driverLoop = /^(\s*)for\s*\(\s*const\s+\w+\s+of\s+(.+)\)\s*\{\s*$/
const integrationGate = /integrationDrivers|postgresIntegration|mysqlIntegration|INTEGRATION|Integration\b/

function walkTestFiles(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((entry) => {
    if (skippedTestDirectories.has(entry)) return []
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return walkTestFiles(path)
    const extension = path.slice(path.lastIndexOf('.'))
    return sourceExtensions.has(extension) ? [path] : []
  })
}

function realDatabaseTestFiles(repoRoot) {
  const workspaceTests = ['packages', 'apps'].flatMap(group => existsSync(join(repoRoot, group))
    ? readdirSync(join(repoRoot, group)).flatMap(entry => walkTestFiles(join(repoRoot, group, entry, 'tests')))
    : [])
  return [...walkTestFiles(join(repoRoot, 'tests')), ...workspaceTests]
}

function callArguments(source, openParen) {
  let depth = 0
  for (let index = openParen; index < source.length; index++) {
    if (source[index] === '(') depth++
    else if (source[index] === ')' && --depth === 0) return source.slice(openParen, index + 1)
  }
  return source.slice(openParen)
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

function gatedIdentifiers(source) {
  const identifiers = new Set()
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=([\s\S]*?)(?:\n\s*\n|$)/g)) {
    if (integrationGate.test(match[2])) identifiers.add(match[1])
  }
  for (const match of source.matchAll(/\bfunction\s+(\w+)\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    if (integrationGate.test(match[2])) identifiers.add(match[1])
  }
  return identifiers
}

function scopeIsGated(text, gated) {
  if (integrationGate.test(text)) return true
  const conditions = [...text.matchAll(/\.(?:runIf|skipIf|each)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)].map(match => match[1])
  return conditions.some(condition => [...condition.matchAll(/\b[A-Za-z_]\w*\b/g)].some(identifier => gated.has(identifier[0])))
}

function scanRealDatabaseScopes(source, gated, gatedFunctions) {
  const lines = source.split('\n')
  const declaredFunctions = new Set([...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(match => match[1]))
  const callSites = new Map()
  const failures = []
  const stack = []
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    const indent = line.length - line.trimStart().length
    while (stack.length > 0 && indent <= stack.at(-1).indent) stack.pop()
    const registration = line.match(testRegistration)
    const loop = line.match(driverLoop)
    const declaration = line.match(/^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
    if (registration) {
      const blockEnd = lines.findIndex((next, nextIndex) => nextIndex > index && next.trim() !== '' && next.length - next.trimStart().length <= indent)
      const block = lines.slice(index, blockEnd === -1 ? undefined : blockEnd).join('\n')
      stack.push({ indent, test: true, gated: scopeIsGated(registration[2], gated), stubsFlags: /vi\.stubEnv\(\s*['"]HOLO_(?:POSTGRES|MYSQL)_INTEGRATION/.test(block) })
    } else if (loop) {
      stack.push({ indent, test: true, gated: scopeIsGated(loop[2], gated), stubsFlags: false })
    } else if (declaration && declaredFunctions.has(declaration[2])) {
      stack.push({ indent, test: false, gated: gatedFunctions.has(declaration[2]), stubsFlags: false })
    }
    const scopeGated = stack.some(scope => scope.gated || scope.stubsFlags)
    for (const name of declaredFunctions) {
      if (!declaration?.[2] || declaration[2] !== name) {
        const call = line.match(new RegExp(`\\b${name}\\(([^)]*)\\)`))
        if (call) callSites.set(name, [...callSites.get(name) ?? [], scopeGated || /^\s*['"]sqlite['"]\s*$/.test(call[1])])
      }
    }
    if (stack.some(scope => scope.test) && realDatabaseCall.test(line) && !scopeGated) failures.push(index + 1)
  })
  return { failures, callSites }
}

function ungatedRealDatabaseLines(source) {
  const gated = gatedIdentifiers(source)
  const { callSites } = scanRealDatabaseScopes(source, gated, new Set())
  const gatedFunctions = new Set([...callSites].filter(([, sites]) => sites.length > 0 && sites.every(Boolean)).map(([name]) => name))
  return scanRealDatabaseScopes(source, gated, gatedFunctions).failures
}

function validateRealDatabaseTests(repoRoot) {
  const failures = []
  for (const file of realDatabaseTestFiles(repoRoot)) {
    const path = relative(repoRoot, file).split('\\').join('/')
    if (realDatabaseAllowedFiles.has(path)) continue
    const source = readFileSync(file, 'utf8')
    for (const variable of new Set([...source.matchAll(realDatabaseEnvRead)].map(match => match[1]))) {
      failures.push(`${path} reads ${variable} from process.env; use ${realDatabaseHelpers}.`)
    }
    for (const database of new Set([...source.matchAll(systemDatabaseName)].map(match => match[1] ?? match[2]))) {
      failures.push(`${path} names the ${database} system database; use the scratch database from ${realDatabaseHelpers}.`)
    }
    if (!sharedConnectionHelper.test(source)) {
      for (const match of source.matchAll(realConnectionConstructor)) {
        if (realConnectionSettings.test(callArguments(source, match.index + match[0].length - 1))) {
          failures.push(`${path}:${lineOf(source, match.index)} opens a real database with ${match[1]} without the shared helpers; build its connection with ${realDatabaseConnectionHelpers}.`)
        }
      }
    }
    for (const line of ungatedRealDatabaseLines(source)) {
      failures.push(`${path}:${line} reaches a real database outside an integration gate; gate it with ${realDatabaseGates}.`)
    }
  }
  return failures
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
  failures.push(...validateRealDatabaseTests(repoRoot))
  return failures.sort()
}

export function runArchitectureValidation(repoRoot) {
  const failures = validateArchitecture(repoRoot)
  if (failures.length > 0) throw new Error(`Architecture validation failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runArchitectureValidation(resolve(fileURLToPath(new URL('..', import.meta.url))))
