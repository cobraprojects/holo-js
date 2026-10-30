import remapping, { type SourceMapInput } from '@jridgewell/remapping'
import MagicString from 'magic-string'
import ts from 'typescript'

export type NextModuleSourceMap = {
  readonly version: 3
  readonly file?: string | null
  readonly sources: readonly (string | null)[]
  readonly sourcesContent?: readonly (string | null)[]
  readonly names: readonly string[]
  readonly mappings: string
}

export type NextModuleTransform = {
  readonly code: string
  readonly map: NextModuleSourceMap
}

/** A source map from an earlier loader, as an object or JSON text. */
export type NextModuleInputSourceMap = string | NextModuleSourceMap

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])

type RuntimeWrapper = 'routeHandler' | 'serverAction'

function isDirective(statement: ts.Statement): statement is ts.ExpressionStatement & { readonly expression: ts.StringLiteral } {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
}

function prologueEnd(statements: readonly ts.Statement[]): number {
  const end = statements.findIndex(statement => !isDirective(statement))
  return end === -1 ? statements.length : end
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement) && Boolean(ts.getModifiers(statement)?.some(modifier => modifier.kind === kind))
}

function boundNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : boundNames(element.name))
}

type NameAllocator = (base: string) => string

function nameAllocator(file: ts.SourceFile): NameAllocator {
  const used = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) used.add(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return (base) => {
    let name = base
    while (used.has(name)) name = `${name}_`
    used.add(name)
    return name
  }
}

function declaredValues(file: ts.SourceFile, defaultName: string): ReadonlySet<string> {
  return new Set(file.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.body) return [statement.name?.text ?? defaultName]
    if (!ts.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name))
  }))
}

function wrappedLocals(file: ts.SourceFile, wraps: (name: string) => boolean, defaultName: string): ReadonlySet<string> {
  const declared = declaredValues(file, defaultName)
  const locals = new Set<string>()
  const add = (local: string, exported: string) => {
    if (declared.has(local) && wraps(exported)) locals.add(local)
  }
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const local = statement.name?.text ?? defaultName
      add(local, hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : local)
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const name of statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name))) add(name, name)
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) add((element.propertyName ?? element.name).text, element.name.text)
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      add(statement.expression.text, 'default')
    }
  }
  return locals
}

function statementEnd(source: string, node: ts.Node): string {
  return source[node.end - 1] === ';' ? '' : ';'
}

function keywordEnd(statement: ts.FunctionDeclaration): number {
  return statement.asteriskToken?.end
    ?? statement.getChildren().find(child => child.kind === ts.SyntaxKind.FunctionKeyword)!.end
}

function defaultFunction(statement: ts.Statement): ts.ExportAssignment | undefined {
  if (!ts.isExportAssignment(statement) || statement.isExportEquals) return undefined
  let expression = statement.expression
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) ? statement : undefined
}

function moduleExportName(name: ts.ModuleExportName): string {
  return ts.isIdentifier(name) ? name.text : JSON.stringify(name.text)
}

// Rebuilt from parsed values, since raw text can hold line continuations that would add lines when copied.
function importSource(moduleSpecifier: ts.StringLiteral, attributes: ts.ImportAttributes | undefined): string {
  const entries = attributes?.elements.map(attribute => `${moduleExportName(attribute.name)}: ${
    ts.isStringLiteral(attribute.value) ? JSON.stringify(attribute.value.text) : attribute.value.getText()}`)
  const keyword = attributes?.token === ts.SyntaxKind.AssertKeyword ? 'assert' : 'with'
  return ` from ${JSON.stringify(moduleSpecifier.text)}${entries ? ` ${keyword} { ${entries.join(', ')} }` : ''}`
}

type RouteExport = {
  readonly local: string
  readonly text: string
}

function localizeRouteExports(statement: ts.Statement, wraps: (name: string) => boolean, declared: ReadonlySet<string>, allocate: NameAllocator): readonly RouteExport[] | undefined {
  if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return undefined
  const { moduleSpecifier } = statement
  const handlers = statement.exportClause.elements.filter(element => !element.isTypeOnly && wraps(element.name.text)
    && (moduleSpecifier || !declared.has((element.propertyName ?? element.name).text)))
  if (handlers.length === 0) return undefined
  const from = moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? importSource(moduleSpecifier, statement.attributes) : ''
  const remaining = statement.exportClause.elements.filter(element => !handlers.includes(element))
  return [
    ...(remaining.length ? [{ local: '', text: `export { ${remaining.map(element => element.getText()).join(', ')} }${from};` }] : []),
    ...handlers.map((handler) => {
      const source = handler.propertyName ?? handler.name
      const imported = moduleSpecifier || !ts.isIdentifier(source) ? allocate(`__holoImported${handler.name.text}`) : source.text
      const local = allocate(`__holoExported${handler.name.text}`)
      const importText = moduleSpecifier ? `import { ${moduleExportName(source)} as ${imported} }${from}; ` : ''
      return { local, text: `${importText}let ${local} = ${imported}; export { ${local} as ${moduleExportName(handler.name)} };` }
    }),
  ]
}

function wrapExports(file: ts.SourceFile, wrapper: RuntimeWrapper, wraps: (name: string) => boolean): MagicString | undefined {
  const source = file.text
  const allocate = nameAllocator(file)
  const defaultName = allocate('__holoDefault')
  const runtimeName = allocate('__holoRouteRuntime')
  const declared = declaredValues(file, defaultName)
  const output = new MagicString(source)
  const locals = new Set(wrappedLocals(file, wraps, defaultName))
  const localized = new Set<string>()
  const reassign = (local: string) => `${local} = ${runtimeName}.${wrapper}(${local});`
  // Keeps the line breaks of a replaced span so the lines after it stay in place.
  const lineBreaks = (text: string) => text.split('\n').length - 1
  const overwrite = (start: number, end: number, text: string) => {
    output.overwrite(start, end, `${text}${'\n'.repeat(Math.max(0, lineBreaks(source.slice(start, end)) - lineBreaks(text)))}`)
  }
  for (const statement of file.statements) {
    const assignment = wraps('default') ? defaultFunction(statement) : undefined
    if (assignment) {
      overwrite(assignment.getStart(), assignment.expression.getStart(), `let ${defaultName} = `)
      output.appendLeft(assignment.end, `${statementEnd(source, assignment)} ${reassign(defaultName)} export default ${defaultName};`)
      localized.add(defaultName)
      continue
    }
    const routeExports = wrapper === 'routeHandler' ? localizeRouteExports(statement, wraps, declared, allocate) : undefined
    if (routeExports) {
      overwrite(statement.getStart(), statement.end, routeExports.map(entry => entry.text).join(' '))
      for (const entry of routeExports) if (entry.local) locals.add(entry.local)
    }
  }
  if (locals.size === 0 && localized.size === 0) return undefined
  const pending = new Set([...locals].filter(local => !localized.has(local)))
  for (const statement of file.statements) {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && pending.delete(statement.expression.text)) {
      output.prependRight(statement.getStart(), `${reassign(statement.expression.text)} `)
    }
    if (ts.isFunctionDeclaration(statement) && statement.body && !statement.name && locals.has(defaultName)) {
      output.appendLeft(keywordEnd(statement), ` ${defaultName}`)
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
      && statement.declarationList.declarations.some(declaration => boundNames(declaration.name).some(name => locals.has(name)))) {
      const keyword = statement.declarationList.getStart()
      output.overwrite(keyword, keyword + 'const'.length, 'let  ')
    }
  }
  // Imports are hoisted, so appending this one leaves every original line where it was.
  const runtimeImport = `import { adapterNextRuntimeInternals as ${runtimeName} } from '@holo-js/adapter-next/runtime';`
  output.append(`\n${[runtimeImport, ...[...pending].map(reassign)].join('\n')}\n`)
  return output
}

function parse(source: string, filename: string): ts.SourceFile {
  return ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, /x$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function transformed(output: MagicString | undefined, filename: string, inputMap: NextModuleInputSourceMap | undefined): NextModuleTransform | undefined {
  if (!output) return undefined
  const map = output.generateMap({ source: filename, includeContent: true, hires: 'boundary' }).toString()
  const chained = inputMap ? remapping([map, inputMap as SourceMapInput], () => null).toString() : map
  const encoded = JSON.parse(chained) as NextModuleSourceMap
  return Object.freeze({ code: output.toString(), map: { ...encoded, file: encoded.file ?? filename } })
}

/**
 * Wraps the HTTP method exports of a Next.js route file with Holo's route runtime.
 * The original text is edited in place, and the returned map points back to it,
 * chained through `inputMap` when an earlier loader passed one.
 * Returns undefined when the file exports no route handlers.
 */
export function transformNextRoute(source: string, filename: string, inputMap?: NextModuleInputSourceMap): NextModuleTransform | undefined {
  return transformed(wrapExports(parse(source, filename), 'routeHandler', name => METHODS.has(name)), filename, inputMap)
}

/**
 * Wraps every export of a `'use server'` module with Holo's server-action runtime.
 * The original text is edited in place, and the returned map points back to it,
 * chained through `inputMap` when an earlier loader passed one.
 * Returns undefined when the module has no leading `'use server'` directive or no exports to wrap.
 */
export function transformNextServerActions(source: string, filename: string, inputMap?: NextModuleInputSourceMap): NextModuleTransform | undefined {
  if (!source.includes('use server')) return undefined
  const file = parse(source, filename)
  const directives = file.statements.slice(0, prologueEnd(file.statements)).filter(isDirective)
  if (!directives.some(directive => directive.expression.text === 'use server')) return undefined
  return transformed(wrapExports(file, 'serverAction', () => true), filename, inputMap)
}

export function compileNextRoute(source: string, filename: string): string {
  return transformNextRoute(source, filename)?.code ?? source
}

export function compileNextServerActions(source: string, filename: string): string {
  return transformNextServerActions(source, filename)?.code ?? source
}
