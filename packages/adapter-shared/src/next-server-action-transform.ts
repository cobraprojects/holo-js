import ts from 'typescript'

const runtimeName = '__holoServerActionRuntime'

function isDirective(statement: ts.Statement): statement is ts.ExpressionStatement & { expression: ts.StringLiteral } {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
}

function wrap(action: ts.Expression): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(runtimeName), 'serverAction'),
    undefined,
    [action],
  )
}

function rewrap(name: ts.Identifier): ts.Statement {
  return ts.factory.createExpressionStatement(ts.factory.createAssignment(name, wrap(name)))
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false
}

function boundNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : boundNames(element.name))
}

function isCachedFunction(node: ts.Node | undefined): boolean {
  if (!node || !(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) || !node.body || !ts.isBlock(node.body)) return false
  const prologueEnd = node.body.statements.findIndex(statement => !isDirective(statement))
  const prologue = prologueEnd < 0 ? node.body.statements : node.body.statements.slice(0, prologueEnd)
  return prologue.some(statement => isDirective(statement) && statement.expression.text.startsWith('use cache'))
}

function cachedNames(statement: ts.Statement): readonly string[] {
  if (ts.isFunctionDeclaration(statement)) return isCachedFunction(statement) && statement.name ? [statement.name.text] : []
  if (!ts.isVariableStatement(statement)) return []
  return statement.declarationList.declarations
    .flatMap(declaration => ts.isIdentifier(declaration.name) && isCachedFunction(declaration.initializer) ? [declaration.name.text] : [])
}

function declaredNames(statement: ts.Statement): readonly string[] {
  if (ts.isFunctionDeclaration(statement) && statement.body && statement.name) return [statement.name.text]
  if (ts.isVariableStatement(statement) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
    return statement.declarationList.declarations.flatMap(declaration => boundNames(declaration.name))
  }
  return []
}

function isLocalExportList(statement: ts.Statement): statement is ts.ExportDeclaration & { exportClause: ts.NamedExports } {
  return ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier
    && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
}

function exportedBindings(statements: readonly ts.Statement[], declared: ReadonlySet<string>, cached: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(statements.flatMap((statement): readonly string[] => {
    if (isLocalExportList(statement)) {
      return statement.exportClause.elements.filter(element => !element.isTypeOnly && element.name.text !== 'default').map(element => (element.propertyName ?? element.name).text)
        .filter(name => declared.has(name))
    }
    return ts.canHaveModifiers(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? declaredNames(statement) : []
  }).filter(name => !cached.has(name)))
}

function exportWrapped(exportName: ts.ModuleExportName, action: ts.Identifier): readonly ts.Statement[] {
  if (exportName.text === 'default') return [ts.factory.createExportAssignment(undefined, undefined, wrap(action))]
  const local = ts.factory.createUniqueName('__holoServerAction')
  return [
    ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(local, undefined, undefined, wrap(action)),
    ], ts.NodeFlags.Const)),
    ts.factory.createExportDeclaration(undefined, false, ts.factory.createNamedExports([
      ts.factory.createExportSpecifier(false, local, exportName),
    ])),
  ]
}

type CompileContext = {
  readonly declared: ReadonlySet<string>
  readonly cached: ReadonlySet<string>
  readonly exported: ReadonlySet<string>
  readonly claimed: Set<string>
  readonly leading: ts.Statement[]
  readonly trailing: ts.Statement[]
}

function compileDeclaration(statement: ts.VariableStatement, declaration: ts.VariableDeclaration, context: CompileContext): readonly ts.Statement[] {
  const list = statement.declarationList
  const exportedNames = boundNames(declaration.name).filter(name => context.exported.has(name))
  const single = (compiled: ts.VariableDeclaration, flags: ts.NodeFlags) => ts.factory.updateVariableStatement(statement, statement.modifiers,
    ts.factory.createVariableDeclarationList([compiled], flags))
  if (!(list.flags & ts.NodeFlags.Const)) {
    context.trailing.push(...exportedNames.map(name => rewrap(ts.factory.createIdentifier(name))))
    return [single(declaration, list.flags)]
  }
  if (!ts.isIdentifier(declaration.name)) {
    return [
      single(declaration, exportedNames.length > 0 ? (list.flags & ~ts.NodeFlags.Const) | ts.NodeFlags.Let : list.flags),
      ...exportedNames.map(name => rewrap(ts.factory.createIdentifier(name))),
    ]
  }
  return [single(exportedNames.length > 0 && declaration.initializer
    ? ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken, declaration.type, wrap(declaration.initializer))
    : declaration, list.flags)]
}

function compileVariableStatement(statement: ts.VariableStatement, context: CompileContext): readonly ts.Statement[] | undefined {
  const declarations = statement.declarationList.declarations
  if (!declarations.some(declaration => boundNames(declaration.name).some(name => context.exported.has(name)))) return undefined
  return declarations.flatMap(declaration => compileDeclaration(statement, declaration, context))
}

function compileStatement(statement: ts.Statement, context: CompileContext): readonly ts.Statement[] | undefined {
  if (ts.isFunctionDeclaration(statement) && statement.body) {
    if (statement.name) {
      if (context.exported.has(statement.name.text)) context.leading.push(rewrap(ts.factory.createIdentifier(statement.name.text)))
      return undefined
    }
    if (!hasModifier(statement, ts.SyntaxKind.DefaultKeyword) || isCachedFunction(statement)) return undefined
    const name = ts.factory.createUniqueName('__holoServerAction')
    context.leading.push(rewrap(name))
    return [ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken, name,
      statement.typeParameters, statement.parameters, statement.type, statement.body)]
  }
  if (ts.isVariableStatement(statement)) return compileVariableStatement(statement, context)
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    const expression = statement.expression
    if (isCachedFunction(expression) || (ts.isIdentifier(expression) && context.cached.has(expression.text))) return undefined
    return [ts.factory.updateExportAssignment(statement, statement.modifiers, wrap(statement.expression))]
  }
  if (isLocalExportList(statement)) {
    const separate = statement.exportClause.elements.filter((element) => {
      if (element.isTypeOnly) return false
      const local = (element.propertyName ?? element.name).text
      if (!context.declared.has(local)) return true
      if (context.cached.has(local)) return false
      if (element.name.text === 'default' || context.claimed.has(local)) return true
      context.claimed.add(local)
      return false
    })
    if (separate.length === 0) return undefined
    for (const element of separate) context.trailing.push(...exportWrapped(element.name, ts.factory.createIdentifier((element.propertyName ?? element.name).text)))
    const remaining = statement.exportClause.elements.filter(element => !separate.includes(element))
    return remaining.length === 0 ? [] : [ts.factory.updateExportDeclaration(statement, statement.modifiers, false,
      ts.factory.updateNamedExports(statement.exportClause, remaining), undefined, statement.attributes)]
  }
  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    const actions = statement.exportClause.elements.filter(element => !element.isTypeOnly)
    if (actions.length === 0) return undefined
    const moduleSpecifier = statement.moduleSpecifier
    return actions.map((element) => {
      const local = ts.factory.createUniqueName('__holoServerAction')
      context.trailing.push(...exportWrapped(element.name, local))
      return ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
        ts.factory.createImportSpecifier(false, element.propertyName ?? element.name, local),
      ])), moduleSpecifier)
    })
  }
  return undefined
}

export function compileNextServerActions(source: string, filename: string): string {
  if (!source.includes('use server')) return source
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const prologueEnd = file.statements.findIndex(statement => !isDirective(statement))
  const prologue = prologueEnd < 0 ? file.statements : file.statements.slice(0, prologueEnd)
  if (!prologue.some(statement => isDirective(statement) && statement.expression.text === 'use server')) return source

  const body = file.statements.slice(prologue.length)
  const declared = new Set(body.flatMap(declaredNames))
  const cached = new Set(body.flatMap(cachedNames))
  const context: CompileContext = {
    declared,
    cached,
    exported: exportedBindings(body, declared, cached),
    claimed: new Set(body.flatMap(statement => ts.canHaveModifiers(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword) ? declaredNames(statement) : [])),
    leading: [],
    trailing: [],
  }
  let changed = false
  const statements = body.flatMap((statement) => {
    const compiled = compileStatement(statement, context)
    if (compiled) changed = true
    return compiled ?? [statement]
  })
  if (!changed && context.leading.length === 0 && context.trailing.length === 0) return source

  const runtimeImport = ts.factory.createImportDeclaration(undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('adapterNextRuntimeInternals'), ts.factory.createIdentifier(runtimeName)),
    ])), ts.factory.createStringLiteral('@holo-js/adapter-next/runtime'))
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file, [...prologue, runtimeImport, ...context.leading, ...statements, ...context.trailing]))
}
