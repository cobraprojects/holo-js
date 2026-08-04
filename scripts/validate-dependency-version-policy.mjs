import { execFile } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function readWorkspaceCatalog(root = repoRoot) {
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!isObject(rootManifest.workspaces) || !isObject(rootManifest.workspaces.catalog)) {
    return new Set()
  }

  return new Set(Object.keys(rootManifest.workspaces.catalog))
}

export async function listTrackedAppManifests(root = repoRoot) {
  const { stdout } = await execFileAsync('git', ['ls-files', 'apps/*/package.json'], {
    cwd: root,
  })

  return stdout
    .split('\n')
    .filter(Boolean)
    .map(filePath => join(root, filePath))
}

export async function listTrackedPackageManifests(root = repoRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', ':(glob)packages/*/package.json'], {
      cwd: root,
    })

    return stdout
      .split('\n')
      .filter(Boolean)
      .map(filePath => join(root, filePath))
  } catch {
    const packageDirectory = join(root, 'packages')
    const entries = await readdir(packageDirectory, { withFileTypes: true })

    const manifests = entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(packageDirectory, entry.name, 'package.json'))

    const existingManifests = []
    for (const manifestPath of manifests) {
      try {
        await access(manifestPath)
        existingManifests.push(manifestPath)
      } catch {
        continue
      }
    }

    return existingManifests
  }
}

export async function collectAppManifestFailures(root = repoRoot) {
  const catalogPackages = await readWorkspaceCatalog(root)
  const manifestPaths = await listTrackedAppManifests(root)
  const failures = []

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    for (const sectionName of dependencySections) {
      const section = manifest[sectionName]
      if (!isObject(section)) {
        continue
      }

      for (const [packageName, version] of Object.entries(section)) {
        if (packageName.startsWith('@holo-js/') && version !== 'workspace:*') {
          failures.push(`${manifestPath}: ${sectionName}.${packageName} must be "workspace:*" in committed apps, found "${version}".`)
          continue
        }

        if (!packageName.startsWith('@holo-js/') && catalogPackages.has(packageName) && version !== 'catalog:') {
          failures.push(`${manifestPath}: ${sectionName}.${packageName} must use "catalog:" in committed apps, found "${version}".`)
        }
      }
    }
  }

  return failures
}

export async function collectPackageManifestFailures(root = repoRoot) {
  const manifestPaths = await listTrackedPackageManifests(root)
  const failures = []

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    for (const sectionName of dependencySections) {
      const section = manifest[sectionName]
      if (!isObject(section)) {
        continue
      }

      for (const [packageName, version] of Object.entries(section)) {
        if (version !== 'catalog:') {
          failures.push(`${manifestPath}: ${sectionName}.${packageName} must use "catalog:" in package manifests, found "${version}".`)
        }
      }
    }
  }

  return failures
}

export async function collectCatalogPackageCoverageFailures(root = repoRoot) {
  const catalogPackages = await readWorkspaceCatalog(root)
  const manifestPaths = await listTrackedPackageManifests(root)
  const failures = []

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (typeof manifest.name === 'string' && !catalogPackages.has(manifest.name)) {
      failures.push(`${manifestPath}: root workspace catalog must include package "${manifest.name}".`)
    }
  }

  return failures
}

export async function collectRootManifestFailures(root = repoRoot) {
  const catalogPackages = await readWorkspaceCatalog(root)
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const failures = []

  for (const sectionName of ['dependencies', 'devDependencies']) {
    const section = manifest[sectionName]
    if (!isObject(section)) {
      continue
    }

    for (const [packageName, version] of Object.entries(section)) {
      const isWorkspaceRange = typeof version === 'string' && version.startsWith('workspace:')
      if (catalogPackages.has(packageName) && version !== 'catalog:' && !isWorkspaceRange) {
        failures.push(`${manifestPath}: ${sectionName}.${packageName} must use "catalog:" in the root manifest, found "${version}".`)
      }
    }
  }

  return failures
}

function collectImportBindings(source) {
  const bindings = new Map()
  const importPattern = /import\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(importPattern)) {
    const specifiers = match[1]?.trim()
    const sourcePath = match[2]
    if (!specifiers || !sourcePath) continue

    const addNamedBindings = (namedSpecifiers) => {
      for (const rawSpecifier of namedSpecifiers.split(',')) {
        const specifier = rawSpecifier.trim()
        if (!specifier) continue
        const aliasMatch = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(specifier)
        if (!aliasMatch) continue
        const importedName = aliasMatch[1]
        const localName = aliasMatch[2] ?? importedName
        bindings.set(localName, { importedName, sourcePath })
      }
    }

    const namespaceMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(specifiers)
    if (namespaceMatch) {
      bindings.set(namespaceMatch[1], { importedName: '*', sourcePath })
      continue
    }

    if (specifiers.startsWith('{') && specifiers.endsWith('}')) {
      addNamedBindings(specifiers.slice(1, -1))
      continue
    }

    const defaultAndRestMatch = /^([A-Za-z_$][\w$]*)(?:\s*,\s*([\s\S]+))?$/.exec(specifiers)
    if (!defaultAndRestMatch) continue

    bindings.set(defaultAndRestMatch[1], { importedName: 'default', sourcePath })
    const restSpecifiers = defaultAndRestMatch[2]?.trim()
    if (!restSpecifiers) continue

    const restNamespaceMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(restSpecifiers)
    if (restNamespaceMatch) {
      bindings.set(restNamespaceMatch[1], { importedName: '*', sourcePath })
      continue
    }

    if (restSpecifiers.startsWith('{') && restSpecifiers.endsWith('}')) {
      addNamedBindings(restSpecifiers.slice(1, -1))
    }
  }
  return bindings
}

function collectNamespaceMemberNames(source, namespaceName) {
  const memberNames = new Set()
  const memberPattern = new RegExp(`\\b${namespaceName}\\.([A-Za-z_$][\\w$]*)\\b`, 'g')
  for (const match of source.matchAll(memberPattern)) {
    if (match[1]) memberNames.add(match[1])
  }
  return memberNames
}

async function collectBindingFailures({
  modulePath,
  source,
  localName,
  binding,
  forbiddenRanges,
  visited,
}) {
  if (!source.includes(localName)) return []

  const resolvedModule = await readResolvedModule(modulePath, binding.sourcePath)
  if (!resolvedModule) return []

  if (binding.importedName === '*') {
    const failures = []
    for (const memberName of collectNamespaceMemberNames(source, localName)) {
      failures.push(...await collectImportedConstantFailures({
        modulePath: resolvedModule.path,
        moduleSource: resolvedModule.source,
        identifier: memberName,
        forbiddenRanges,
        visited,
      }))
    }
    return failures
  }

  return collectImportedConstantFailures({
    modulePath: resolvedModule.path,
    moduleSource: resolvedModule.source,
    identifier: binding.importedName,
    forbiddenRanges,
    visited,
  })
}

function collectExportInitializer(source, exportName) {
  if (exportName === 'default') {
    const exportMatch = /\bexport\s+default\b/.exec(source)
    if (!exportMatch) return undefined
    const initializerStart = exportMatch.index + exportMatch[0].length
    const nextExport = source.slice(initializerStart + 1).search(/\nexport\s+(?:const|function|class|type|interface|default)\s/)
    const initializerEnd = nextExport === -1
      ? source.length
      : initializerStart + 1 + nextExport
    return source.slice(initializerStart, initializerEnd)
  }

  const exportPattern = new RegExp(`export\\s+const\\s+${exportName}\\b`)
  const exportMatch = exportPattern.exec(source)
  if (!exportMatch) return undefined

  const initializerStart = source.indexOf('=', exportMatch.index)
  if (initializerStart === -1) return undefined

  const nextExport = source.slice(initializerStart + 1).search(/\nexport\s+(?:const|function|class|type|interface|default)\s/)
  const initializerEnd = nextExport === -1
    ? source.length
    : initializerStart + 1 + nextExport
  return source.slice(initializerStart + 1, initializerEnd)
}

function collectFunctionBody(source, functionName) {
  const functionPattern = new RegExp(`function\\s+${functionName}\\b[\\s\\S]*?{`)
  const functionMatch = functionPattern.exec(source)
  if (functionMatch) {
    let depth = 1
    let index = functionMatch.index + functionMatch[0].length
    while (index < source.length && depth > 0) {
      const current = source[index]
      if (current === '{') depth += 1
      if (current === '}') depth -= 1
      index += 1
    }

    return source.slice(functionMatch.index, index)
  }

  const variableFunctionPattern = new RegExp(`(?:const|let|var)\\s+${functionName}\\b\\s*=`)
  const variableFunctionMatch = variableFunctionPattern.exec(source)
  if (!variableFunctionMatch) return undefined

  const initializerStart = source.indexOf('=', variableFunctionMatch.index)
  if (initializerStart === -1) return undefined

  const nextDeclaration = source.slice(initializerStart + 1).search(/\n(?:export\s+)?(?:const|let|var|function|class|type|interface)\s/)
  const initializerEnd = nextDeclaration === -1
    ? source.length
    : initializerStart + 1 + nextDeclaration
  return source.slice(variableFunctionMatch.index, initializerEnd)
}

async function readResolvedModule(importerPath, importSource) {
  if (!importSource.startsWith('.')) return undefined
  const basePath = resolve(dirname(importerPath), importSource)
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    join(basePath, 'index.ts'),
  ]

  for (const candidate of candidates) {
    try {
      return {
        path: candidate,
        source: await readFile(candidate, 'utf8'),
      }
    } catch {
      continue
    }
  }

  return undefined
}

async function collectImportedConstantFailures({
  modulePath,
  moduleSource,
  identifier,
  forbiddenRanges,
  visited,
}) {
  const visitKey = `${modulePath}:${identifier}`
  if (visited.has(visitKey)) return []
  visited.add(visitKey)

  const initializer = collectExportInitializer(moduleSource, identifier)
  if (!initializer) return []

  const directForbiddenRange = forbiddenRanges.find(range => initializer.includes(range))
  if (directForbiddenRange) {
    return [`${modulePath}: imported scaffold dependency constant ${identifier} must not contain ${directForbiddenRange} ranges.`]
  }

  const importBindings = collectImportBindings(moduleSource)
  const failures = []
  for (const [localName, binding] of importBindings) {
    failures.push(...await collectBindingFailures({
      modulePath,
      source: initializer,
      localName,
      binding,
      forbiddenRanges,
      visited,
    }))
  }

  for (const callMatch of initializer.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const functionBody = collectFunctionBody(moduleSource, callMatch[1])
    if (!functionBody) continue
    const forbiddenRange = forbiddenRanges.find(range => functionBody.includes(range))
    if (forbiddenRange) {
      failures.push(`${modulePath}: scaffold dependency helper ${callMatch[1]} used by ${identifier} must not contain ${forbiddenRange} ranges.`)
    }

    for (const [localName, binding] of importBindings) {
      failures.push(...await collectBindingFailures({
        modulePath,
        source: functionBody,
        localName,
        binding,
        forbiddenRanges,
        visited,
      }))
    }
  }

  return failures
}

export async function collectScaffoldSourceFailures(root = repoRoot) {
  const scaffoldPath = join(root, 'packages/cli/src/project/scaffold/framework.ts')
  const source = await readFile(scaffoldPath, 'utf8')
  const renderStart = source.indexOf('export function renderScaffoldPackageJson')
  const renderEnd = source.indexOf('\nexport async function scaffoldProject', renderStart)

  if (renderStart === -1 || renderEnd === -1) {
    return [`${scaffoldPath}: could not locate renderScaffoldPackageJson for dependency policy validation.`]
  }

  const renderSource = source.slice(renderStart, renderEnd)
  const forbiddenRanges = ['workspace:', 'catalog:']
  const forbiddenRange = forbiddenRanges.find(range => renderSource.includes(range))
  if (forbiddenRange) {
    return [`${scaffoldPath}: generated user project manifests must not contain ${forbiddenRange} dependency ranges.`]
  }

  const failures = []
  const importBindings = collectImportBindings(source)
  for (const [localName, binding] of importBindings) {
    failures.push(...await collectBindingFailures({
      modulePath: scaffoldPath,
      source: renderSource,
      localName,
      binding,
      forbiddenRanges,
      visited: new Set(),
    }))
  }

  return failures
}

export async function runDependencyVersionPolicyValidation(root = repoRoot) {
  const failures = [
    ...(await collectRootManifestFailures(root)),
    ...(await collectAppManifestFailures(root)),
    ...(await collectPackageManifestFailures(root)),
    ...(await collectCatalogPackageCoverageFailures(root)),
    ...(await collectScaffoldSourceFailures(root)),
  ]

  if (failures.length > 0) {
    console.error('Dependency version policy failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    return 1
  }

  console.log('Dependency version policy validated.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runDependencyVersionPolicyValidation())
}
