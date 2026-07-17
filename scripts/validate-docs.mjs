import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const docsImportCompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
}

const repositoryRoot = resolve(import.meta.dirname, '..')
const workspacePackageDirectories = readdirSync(join(repositoryRoot, 'packages'))
  .map(entry => join(repositoryRoot, 'packages', entry))
  .filter(directory => existsSync(join(directory, 'package.json')))
const workspacePackages = workspacePackageDirectories.map((directory) => {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  return { directory, manifest }
}).filter(entry => typeof entry.manifest.name === 'string')
const packageExportCache = new Map()

function resolveExportTarget(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const condition of ['types', 'import', 'default', 'node']) {
    const resolved = resolveExportTarget(value[condition])
    if (resolved) return resolved
  }
  return undefined
}

function resolveWorkspacePackageDeclaration(specifier) {
  const workspacePackage = workspacePackages
    .filter(entry => specifier === entry.manifest.name || specifier.startsWith(`${entry.manifest.name}/`))
    .sort((left, right) => right.manifest.name.length - left.manifest.name.length)[0]
  if (!workspacePackage) return undefined

  const subpath = specifier.slice(workspacePackage.manifest.name.length)
  const exportKey = subpath ? `.${subpath}` : '.'
  const exports = workspacePackage.manifest.exports
  const target = typeof exports === 'string'
    ? (exportKey === '.' ? exports : undefined)
    : resolveExportTarget(exports?.[exportKey])
      ?? (exportKey === '.' ? workspacePackage.manifest.types : undefined)
  if (!target) return undefined

  const declarationPath = resolve(workspacePackage.directory, target)
  if (existsSync(declarationPath)) return declarationPath
  if (declarationPath.endsWith('.mjs')) {
    const dtsPath = declarationPath.replace(/\.mjs$/, '.d.ts')
    if (existsSync(dtsPath)) return dtsPath
  }
  return undefined
}

function validateHoloImports(source, file, line, failures) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const containingFile = resolve('.holo-docs-import-validation.ts')

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith('@holo-js/')) continue

    const resolvedFileName = resolveWorkspacePackageDeclaration(specifier)
      ?? ts.resolveModuleName(
        specifier,
        containingFile,
        docsImportCompilerOptions,
        ts.sys,
      ).resolvedModule?.resolvedFileName
    if (!resolvedFileName) {
      failures.push(`${file}:${line} imports unresolved package ${specifier}.`)
      continue
    }

    let exports = packageExportCache.get(resolvedFileName)
    if (!exports) {
      const program = ts.createProgram([resolvedFileName], docsImportCompilerOptions)
      const resolvedSource = program.getSourceFile(resolvedFileName)
      if (!resolvedSource) {
        failures.push(`${file}:${line} cannot read declarations for ${specifier}.`)
        continue
      }

      const checker = program.getTypeChecker()
      const moduleSymbol = checker.getSymbolAtLocation(resolvedSource)
      if (!moduleSymbol) {
        failures.push(`${file}:${line} cannot inspect exports for ${specifier}.`)
        continue
      }

      exports = new Set(checker.getExportsOfModule(moduleSymbol).map(symbol => symbol.name))
      packageExportCache.set(resolvedFileName, exports)
    }
    const importClause = statement.importClause
    if (!importClause) continue
    if (importClause.name && !exports.has('default')) {
      failures.push(`${file}:${line} imports a missing default export from ${specifier}.`)
    }
    if (!importClause.namedBindings || !ts.isNamedImports(importClause.namedBindings)) continue

    for (const element of importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (!exports.has(importedName)) {
        failures.push(`${file}:${line} imports missing export ${importedName} from ${specifier}.`)
      }
    }
  }
}

function markdownFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (entry === '.vitepress') return []
    return statSync(path).isDirectory() ? markdownFiles(path) : extname(path) === '.md' ? [path] : []
  })
}

function routeExists(docsRoot, route) {
  const cleanRoute = route.split('#')[0].split('?')[0]
  if (!cleanRoute || cleanRoute === '/') return existsSync(join(docsRoot, 'index.md'))
  const relativeRoute = cleanRoute.replace(/^\//, '')
  return existsSync(join(docsRoot, `${relativeRoute}.md`)) || existsSync(join(docsRoot, relativeRoute, 'index.md'))
}

export function validateDocs(docsRoot) {
  const failures = []
  for (const file of markdownFiles(docsRoot)) {
    const source = readFileSync(file, 'utf8')
    if (/import \{[^}]*define(?:Auth|Broadcast|Cache|Cors|Database|Mail|Media|Notifications|Queue|Redis|Security|Session|Storage)Config[^}]*\} from '@holo-js\/config'/.test(source)) {
      failures.push(`${file} uses a feature config helper from @holo-js/config.`)
    }
    if (/import \{[^}]*defineHoloPlugin[^}]*\} from '@holo-js\/cli'/.test(source)) {
      failures.push(`${file} imports defineHoloPlugin from @holo-js/cli instead of @holo-js/kernel.`)
    }
    for (const match of source.matchAll(/\[[^\]]*\]\((\/[^)]+)\)/g)) {
      if (!routeExists(docsRoot, match[1])) failures.push(`${file} links to missing route ${match[1]}.`)
    }
    for (const match of source.matchAll(/```(?:ts|typescript)\s*\n([\s\S]*?)```/g)) {
      const line = source.slice(0, match.index).split('\n').length
      validateHoloImports(match[1], file, line, failures)
      const candidates = [
        match[1],
        `const example = (\n${match[1]}\n)`,
        `const example = ({\n${match[1]}\n})`,
        `async function example() {\n${match[1]}\n}`,
      ]
      const diagnostics = candidates.map(candidate => ts.transpileModule(candidate, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
          },
          fileName: file,
          reportDiagnostics: true,
        }).diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [])
      if (diagnostics.some(candidateDiagnostics => candidateDiagnostics.length === 0)) continue
      for (const diagnostic of diagnostics.sort((left, right) => left.length - right.length)[0]) {
        failures.push(`${file}:${line} contains an invalid TypeScript example: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
      }
    }
  }
  return failures
}

export function runDocsValidation(docsRoot) {
  const failures = validateDocs(docsRoot)
  if (failures.length) throw new Error(`Documentation validation failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) runDocsValidation(resolve(process.argv[2] ?? 'apps/docs/docs'))
