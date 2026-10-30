import ts from 'typescript'

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])
const runtimeName = '__holoRouteRuntime'

type RuntimeWrapper = 'routeHandler' | 'serverAction'

function wrap(wrapper: RuntimeWrapper, handler: ts.Expression): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(runtimeName), wrapper),
    undefined,
    [handler],
  )
}

function constant(name: string | ts.Identifier, initializer: ts.Expression, exported: boolean): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    exported ? [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)] : undefined,
    ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(name, undefined, undefined, initializer),
    ], ts.NodeFlags.Const),
  )
}

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

function localExportNames(file: ts.SourceFile, wraps: (name: string) => boolean): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly && wraps(element.name.text)) names.add((element.propertyName ?? element.name).text)
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression) && wraps('default')) {
      names.add(statement.expression.text)
    }
  }
  return names
}

function declaredNames(file: ts.SourceFile): ReadonlySet<string> {
  return new Set(file.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text]
    if (!ts.isVariableStatement(statement)) return []
    return statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name).map(name => name.text))
  }))
}

function typeNames(file: ts.SourceFile): ReadonlySet<string> {
  return new Set(file.statements.flatMap((statement) => {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return [statement.name.text]
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return []
    return clause.namedBindings.elements
      .filter(element => element.isTypeOnly || clause.isTypeOnly)
      .map(element => element.name.text)
  }))
}

function boundNames(name: ts.BindingName): readonly ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : boundNames(element.name))
}

function originalName(name: string): ts.Identifier {
  return ts.factory.createIdentifier(`__holoOriginal${name}`)
}

function renameBindings(name: ts.BindingName, needsWrap: (name: string) => boolean, renamed: ts.Identifier[]): ts.BindingName {
  if (ts.isIdentifier(name)) {
    if (!needsWrap(name.text)) return name
    renamed.push(name)
    return originalName(name.text)
  }
  if (ts.isObjectBindingPattern(name)) {
    return ts.factory.updateObjectBindingPattern(name, name.elements.map(element => ts.factory.updateBindingElement(element,
      element.dotDotDotToken,
      element.propertyName ?? (ts.isIdentifier(element.name) && !element.dotDotDotToken && needsWrap(element.name.text) ? ts.factory.createIdentifier(element.name.text) : undefined),
      renameBindings(element.name, needsWrap, renamed), element.initializer)))
  }
  return ts.factory.updateArrayBindingPattern(name, name.elements.map(element => ts.isOmittedExpression(element)
    ? element
    : ts.factory.updateBindingElement(element, element.dotDotDotToken, element.propertyName,
      renameBindings(element.name, needsWrap, renamed), element.initializer)))
}

function wrapExports(file: ts.SourceFile, wrapper: RuntimeWrapper, wraps: (name: string) => boolean): string | undefined {
  const localExports = localExportNames(file, wraps)
  const declared = declaredNames(file)
  const types = typeNames(file)
  const wrapsLocal = (name: string) => localExports.has(name) && declared.has(name)
  const leading: ts.Statement[] = []
  const trailing: ts.Statement[] = []
  let changed = false
  const statements = file.statements.flatMap((statement): readonly ts.Statement[] => {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      const isDefault = exported && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      const name = statement.name?.text
      const wrapsExport = exported && wraps(isDefault ? 'default' : name ?? '')
      if (!wrapsExport && !(name && wrapsLocal(name))) return [statement]
      changed = true
      const original = originalName(name ?? 'default')
      const declaration = ts.factory.updateFunctionDeclaration(statement,
        statement.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
        statement.asteriskToken, original, statement.typeParameters, statement.parameters, statement.type, statement.body)
      if (!name) return [declaration, ts.factory.createExportAssignment(undefined, false, wrap(wrapper, original))]
      leading.push(constant(name, wrap(wrapper, original), exported && !isDefault))
      return [declaration, ...(isDefault ? [ts.factory.createExportAssignment(undefined, false, ts.factory.createIdentifier(name))] : [])]
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && wraps('default')
      && !(ts.isIdentifier(statement.expression) && declared.has(statement.expression.text))) {
      changed = true
      return [ts.factory.createExportAssignment(undefined, false, wrap(wrapper, statement.expression))]
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      const needsWrap = (name: string) => exported ? wraps(name) : wrapsLocal(name)
      const destructured: ts.Identifier[] = []
      const declarations = statement.declarationList.declarations.map((declaration) => {
        if (!ts.isIdentifier(declaration.name)) {
          return ts.factory.updateVariableDeclaration(declaration, renameBindings(declaration.name, needsWrap, destructured),
            declaration.exclamationToken, declaration.type, declaration.initializer)
        }
        if (!declaration.initializer || !needsWrap(declaration.name.text)) return declaration
        changed = true
        return ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken,
          declaration.type, wrap(wrapper, declaration.initializer))
      })
      const list = ts.factory.updateVariableDeclarationList(statement.declarationList, declarations)
      if (destructured.length === 0) return [ts.factory.updateVariableStatement(statement, statement.modifiers, list)]
      changed = true
      const modifiers = statement.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword)
      const exportedNames = statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name))
      return [
        ts.factory.updateVariableStatement(statement, modifiers, list),
        ...destructured.map(name => constant(name.text, wrap(wrapper, originalName(name.text)), false)),
        ...(exported ? [ts.factory.createExportDeclaration(undefined, false, ts.factory.createNamedExports(
          exportedNames.map(name => ts.factory.createExportSpecifier(false, undefined, name.text)),
        ))] : []),
      ]
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const handlers = statement.exportClause.elements.filter(element => !element.isTypeOnly && wraps(element.name.text)
        && (statement.moduleSpecifier || ![declared, types].some(names => names.has((element.propertyName ?? element.name).text))))
      if (handlers.length === 0) return [statement]
      changed = true
      const result: ts.Statement[] = []
      const remaining = statement.exportClause.elements.filter(element => !handlers.includes(element))
      if (remaining.length) result.push(ts.factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly,
        ts.factory.updateNamedExports(statement.exportClause, remaining), statement.moduleSpecifier, statement.attributes))
      for (const handler of handlers) {
        const imported = handler.propertyName ?? handler.name
        const local = !statement.moduleSpecifier && ts.isIdentifier(imported) ? imported : ts.factory.createIdentifier(`__holoImported${handler.name.text}`)
        if (statement.moduleSpecifier) result.push(ts.factory.createImportDeclaration(undefined,
          ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
            ts.factory.createImportSpecifier(false, imported, local),
          ])), statement.moduleSpecifier))
        const wrapped = ts.factory.createIdentifier(`__holoWrapped${handler.name.text}`)
        trailing.push(constant(wrapped, wrap(wrapper, local), false), ts.factory.createExportDeclaration(undefined, false,
          ts.factory.createNamedExports([ts.factory.createExportSpecifier(false, wrapped, handler.name)])))
      }
      return result
    }
    return [statement]
  })
  if (!changed) return undefined
  const runtimeImport = ts.factory.createImportDeclaration(undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('adapterNextRuntimeInternals'), ts.factory.createIdentifier(runtimeName)),
    ])), ts.factory.createStringLiteral('@holo-js/adapter-next/runtime'))
  const insertAt = prologueEnd(statements)
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file,
    [...statements.slice(0, insertAt), runtimeImport, ...leading, ...statements.slice(insertAt), ...trailing]))
}

function parse(source: string, filename: string): ts.SourceFile {
  return ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, /x$/.test(filename) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

export function compileNextRoute(source: string, filename: string): string {
  return wrapExports(parse(source, filename), 'routeHandler', name => METHODS.has(name)) ?? source
}

export function compileNextServerActions(source: string, filename: string): string {
  if (!source.includes('use server')) return source
  const file = parse(source, filename)
  const directives = file.statements.slice(0, prologueEnd(file.statements)).filter(isDirective)
  if (!directives.some(directive => directive.expression.text === 'use server')) return source
  return wrapExports(file, 'serverAction', () => true) ?? source
}
