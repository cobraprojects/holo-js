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
const realDatabaseAllowedFiles = new Set(['tests/support/real-database.ts', 'packages/db/tests/support-database.test.ts', 'packages/db/tests/support/database.ts', 'tests/native-library-suite.mjs', 'tests/example-app-matrix.mjs'])
const skippedTestDirectories = new Set(['node_modules', 'dist', '.output', '.nuxt', '.next', '.svelte-kit'])
const realDatabaseSetting = /\b(HOLO_(?:POSTGRES|MYSQL|\$\{[^}]+\})_(?:HOST|PORT|USER|PASSWORD|DATABASE|URL))\b/g
const systemDatabaseNames = 'postgres|template0|template1|mysql|information_schema|performance_schema|sys'
const systemDatabaseName = new RegExp(`(?:database|DATABASE)[^\\n]*?\\?\\?\\s*['"](${systemDatabaseNames})['"]|\\bdatabase\\s*:\\s*['"](${systemDatabaseNames})['"]`, 'gi')
const adapterConstructor = /\b(createPostgresAdapter|createMySQLAdapter|postgresDatabaseDriverFactory\.create|mysqlDatabaseDriverFactory\.create)\s*\(/g
const realConnectionSettings = /\b(?:host|port|user|database|config|connectionString|url|uri)\s*:|[{,]\s*(?:host|port|user|database|config|connectionString|url|uri)\s*[,}]|[`'"](?:postgres(?:ql)?|mysql):\/\//
const sharedConnectionHelper = /\b(?:postgresTestConnection|mysqlTestConnection|testConnectionUrl)\s*\(/
const injectedDriverFake = /\b(?:Client|client|pool|createPoolInstance)\s*:/

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

function escapeIdentifier(name) {
  return name.replaceAll('$', '\\$')
}

function indentAt(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1
  const line = source.slice(lineStart, source.indexOf('\n', lineStart) === -1 ? undefined : source.indexOf('\n', lineStart))
  return line.length - line.trimStart().length
}

function declarationEnclosesPosition(source, declarationIndex, position) {
  const indent = indentAt(source, declarationIndex)
  const between = source.slice(source.indexOf('\n', declarationIndex) + 1, source.lastIndexOf('\n', position) + 1).split('\n')
  return between.every(line => line.trim() === '' || line.length - line.trimStart().length >= indent)
}

function declarationOf(source, name, position) {
  const identifier = escapeIdentifier(name)
  const declaration = new RegExp(`\\b(?:(?:const|let|var)\\s+(?:\\{[^}]*\\b${identifier}\\b[^}]*\\}|\\[[^\\]]*\\b${identifier}\\b[^\\]]*\\]|${identifier}\\b)[^=]*=|(?:async\\s+)?function\\s+${identifier}\\b)`, 'g')
  const matches = [...source.matchAll(declaration)]
  const match = matches.filter(candidate => candidate.index < position && declarationEnclosesPosition(source, candidate.index, position)).at(-1)
    ?? matches.find(candidate => /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(source.slice(source.lastIndexOf('\n', candidate.index) + 1)) && indentAt(source, candidate.index) === 0)
  if (!match) return undefined
  const indent = indentAt(source, match.index)
  const rest = source.slice(match.index).split('\n')
  const end = rest.findIndex((line, index) => index > 0 && line.trim() !== '' && line.length - line.trimStart().length <= indent && !/^\s*[)}\]]/.test(line))
  return { index: match.index, text: rest.slice(0, end === -1 ? undefined : end).join('\n') }
}

function resolvedConnectionText(source, text, position, depth = 2, seen = new Set()) {
  if (depth === 0) return text
  const identifiers = [...new Set([...text.replaceAll('...', '   ').matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$]|\s*:(?!:))/g)].map(match => match[0]))].filter(identifier => !seen.has(identifier))
  const resolved = new Set([...seen, ...identifiers])
  const declarations = identifiers.map(identifier => declarationOf(source, identifier, position)).filter(Boolean)
  return [text, ...declarations.map(declaration => resolvedConnectionText(source, declaration.text, declaration.index, depth - 1, resolved))].join('\n')
}

const rawDriverModule = `['"](pg|mysql2(?:\\/promise)?)['"]`
const namespaceMethods = { pg: ['new\\s+', '\\.(?:Client|Pool)'], mysql2: ['', '\\.(?:createConnection|createPool)'] }

function rawDriverConstructors(source) {
  const patterns = []
  const addNamed = (imported, local) => {
    if (imported === 'Client' || imported === 'Pool') patterns.push(`new\\s+${escapeIdentifier(local)}`)
    if (imported === 'createConnection' || imported === 'createPool') patterns.push(escapeIdentifier(local))
  }
  const namespaces = []
  const addNamespace = (local, module) => {
    const [prefix, member] = namespaceMethods[module.startsWith('pg') ? 'pg' : 'mysql2']
    patterns.push(`${prefix}${escapeIdentifier(local)}${member}`)
    namespaces.push({ local, module })
  }
  const addBinding = (imported, local, module) => {
    if (imported === 'default') addNamespace(local, module)
    else addNamed(imported, local)
  }
  const importStatement = new RegExp(`import\\s+(?!type\\b)([^'";]*?)\\s+from\\s*${rawDriverModule}`, 'g')
  for (const match of source.matchAll(importStatement)) {
    const clause = match[1]
    const named = clause.match(/\{([^}]*)\}/)
    for (const binding of named?.[1].split(',') ?? []) {
      const [imported, local = imported] = binding.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map(name => name.trim())
      if (imported) addNamed(imported, local)
    }
    const defaultOrNamespace = clause.replace(/\{[^}]*\}/, '').split(',').map(part => part.trim().replace(/^\*\s+as\s+/, '')).filter(Boolean)
    for (const local of defaultOrNamespace) addNamespace(local, match[2])
  }
  const loader = `(?:await\\s+import|require)\\(\\s*${rawDriverModule}\\s*\\)`
  for (const match of source.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${loader}`, 'g'))) addNamespace(match[1], match[2])
  for (const match of source.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${loader}`, 'g'))) {
    for (const binding of match[1].split(',')) {
      const [imported, local = imported] = binding.trim().split(/\s*:\s*/).map(name => name.trim())
      if (imported) addBinding(imported, local, match[2])
    }
  }
  for (const { local, module } of [...namespaces]) {
    for (const match of source.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${escapeIdentifier(local)}\\b(?!\\s*[.(\\[])`, 'g'))) {
      for (const binding of match[1].split(',')) {
        const [imported, alias = imported] = binding.trim().split(/\s*:\s*/).map(name => name.trim())
        if (imported) addBinding(imported, alias, module)
      }
    }
  }
  return patterns.length > 0 ? new RegExp(`(?<![\\w$.])(${patterns.join('|')})\\s*\\(`, 'g') : undefined
}

function validateRealDatabaseTests(repoRoot) {
  const failures = []
  for (const file of realDatabaseTestFiles(repoRoot)) {
    const path = relative(repoRoot, file).split('\\').join('/')
    if (realDatabaseAllowedFiles.has(path)) continue
    const source = readFileSync(file, 'utf8')
    for (const variable of new Set([...source.matchAll(realDatabaseSetting)].map(match => match[1]))) {
      failures.push(`${path} reads ${variable}; use ${realDatabaseHelpers}.`)
    }
    for (const database of new Set([...source.matchAll(systemDatabaseName)].map(match => (match[1] ?? match[2]).toLowerCase()))) {
      failures.push(`${path} names the ${database} system database; use the scratch database from ${realDatabaseHelpers}.`)
    }
    const driversMocked = /\bvi\.mock\(\s*['"](?:pg|mysql2(?:\/promise)?)['"]/.test(source)
    const calls = driversMocked ? [] : [
      ...[...source.matchAll(adapterConstructor)].map(match => ({ match, raw: false })),
      ...[...source.matchAll(rawDriverConstructors(source) ?? /$^/g)].map(match => ({ match, raw: true })),
    ]
    for (const { match, raw } of calls) {
      const argumentsText = callArguments(source, match.index + match[0].length - 1)
      const resolved = resolvedConnectionText(source, argumentsText, match.index)
      if (sharedConnectionHelper.test(resolved) || (!raw && injectedDriverFake.test(argumentsText))) continue
      if (raw || realConnectionSettings.test(resolved)) {
        failures.push(`${path}:${lineOf(source, match.index)} opens a real database with ${match[1].replace(/\s+/g, ' ')} outside the shared helpers; build its connection with ${realDatabaseConnectionHelpers}.`)
      }
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
  if (failures.length === 0) return
  const realDatabaseNote = failures.some(failure => failure.includes('tests/support/real-database.ts'))
    ? '\nThis static check is a best-effort first line. The Real-database gating CI job (bun run test:real-database-gating) is the authoritative check that every PostgreSQL and MySQL test skips without its integration flag.'
    : ''
  throw new Error(`Architecture validation failed:\n${failures.map(failure => `- ${failure}`).join('\n')}${realDatabaseNote}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runArchitectureValidation(resolve(fileURLToPath(new URL('..', import.meta.url))))
