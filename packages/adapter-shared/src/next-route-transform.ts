import ts from 'typescript'

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

function reassignable(statement: ts.Statement, locals: ReadonlySet<string>, defaultName: string): ts.Statement {
  if (ts.isFunctionDeclaration(statement) && statement.body && !statement.name && locals.has(defaultName)) {
    return ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken,
      ts.factory.createIdentifier(defaultName), statement.typeParameters, statement.parameters, statement.type, statement.body)
  }
  if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const
    && statement.declarationList.declarations.some(declaration => boundNames(declaration.name).some(name => locals.has(name)))) {
    return ts.factory.updateVariableStatement(statement, statement.modifiers,
      ts.factory.createVariableDeclarationList(statement.declarationList.declarations, ts.NodeFlags.Let))
  }
  return statement
}

function localizeRouteExports(statement: ts.Statement, wraps: (name: string) => boolean, declared: ReadonlySet<string>, allocate: NameAllocator): readonly ts.Statement[] {
  if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return [statement]
  const { moduleSpecifier } = statement
  const handlers = statement.exportClause.elements.filter(element => !element.isTypeOnly && wraps(element.name.text)
    && (moduleSpecifier || !declared.has((element.propertyName ?? element.name).text)))
  if (handlers.length === 0) return [statement]
  const remaining = statement.exportClause.elements.filter(element => !handlers.includes(element))
  return [
    ...(remaining.length ? [ts.factory.updateExportDeclaration(statement, statement.modifiers, false,
      ts.factory.updateNamedExports(statement.exportClause, remaining), moduleSpecifier, statement.attributes)] : []),
    ...handlers.flatMap((handler) => {
      const source = handler.propertyName ?? handler.name
      const imported = moduleSpecifier || !ts.isIdentifier(source) ? ts.factory.createIdentifier(allocate(`__holoImported${handler.name.text}`)) : source
      const local = ts.factory.createIdentifier(allocate(`__holoExported${handler.name.text}`))
      return [
        ...(moduleSpecifier ? [ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
          ts.factory.createImportSpecifier(false, source, imported),
        ])), moduleSpecifier)] : []),
        ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(local, undefined, undefined, imported),
        ], ts.NodeFlags.Let)),
        ts.factory.createExportDeclaration(undefined, false, ts.factory.createNamedExports([
          ts.factory.createExportSpecifier(false, local, handler.name),
        ])),
      ]
    }),
  ]
}

function wrapExports(source: ts.SourceFile, wrapper: RuntimeWrapper, wraps: (name: string) => boolean): string | undefined {
  const allocate = nameAllocator(source)
  const defaultName = allocate('__holoDefault')
  const runtimeName = allocate('__holoRouteRuntime')
  const declared = declaredValues(source, defaultName)
  const file = wrapper === 'routeHandler'
    ? ts.factory.updateSourceFile(source, source.statements.flatMap(statement => localizeRouteExports(statement, wraps, declared, allocate)))
    : source
  const locals = wrappedLocals(file, wraps, defaultName)
  if (locals.size === 0) return undefined
  const runtimeImport = ts.factory.createImportDeclaration(undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('adapterNextRuntimeInternals'), ts.factory.createIdentifier(runtimeName)),
    ])), ts.factory.createStringLiteral('@holo-js/adapter-next/runtime'))
  const reassign = (local: string) => ts.factory.createExpressionStatement(ts.factory.createAssignment(
    ts.factory.createIdentifier(local),
    ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(runtimeName), wrapper),
      undefined,
      [ts.factory.createIdentifier(local)],
    ),
  ))
  const pending = new Set(locals)
  const statements = file.statements.flatMap((statement): readonly ts.Statement[] => {
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && pending.delete(statement.expression.text)) {
      return [reassign(statement.expression.text), statement]
    }
    return [reassignable(statement, locals, defaultName)]
  })
  const insertAt = prologueEnd(statements)
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file,
    [...statements.slice(0, insertAt), runtimeImport, ...statements.slice(insertAt), ...[...pending].map(reassign)]))
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
