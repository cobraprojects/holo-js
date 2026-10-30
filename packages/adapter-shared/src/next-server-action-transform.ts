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

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false
}

function exportWrapped(exportName: string, action: ts.Identifier): readonly ts.Statement[] {
  if (exportName === 'default') return [ts.factory.createExportAssignment(undefined, undefined, wrap(action))]
  const local = ts.factory.createIdentifier(`__holoServerAction_${exportName}`)
  return [
    ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(local, undefined, undefined, wrap(action)),
    ], ts.NodeFlags.Const)),
    ts.factory.createExportDeclaration(undefined, false, ts.factory.createNamedExports([
      ts.factory.createExportSpecifier(false, local, exportName),
    ])),
  ]
}

function compileStatement(statement: ts.Statement): readonly ts.Statement[] | undefined {
  if (ts.isFunctionDeclaration(statement) && statement.body && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    const exportName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name!.text
    const name = statement.name ?? ts.factory.createIdentifier('__holoServerAction_default')
    const modifiers = statement.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword)
    return [
      ts.factory.updateFunctionDeclaration(statement, modifiers, statement.asteriskToken, name,
        statement.typeParameters, statement.parameters, statement.type, statement.body),
      ...exportWrapped(exportName, name),
    ]
  }
  if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return [ts.factory.updateVariableStatement(statement, statement.modifiers,
      ts.factory.updateVariableDeclarationList(statement.declarationList, statement.declarationList.declarations.map(declaration =>
        ts.isIdentifier(declaration.name) && declaration.initializer
          ? ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken, declaration.type, wrap(declaration.initializer))
          : declaration)))]
  }
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    return [ts.factory.updateExportAssignment(statement, statement.modifiers, wrap(statement.expression))]
  }
  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    const actions = statement.exportClause.elements.filter(element => !element.isTypeOnly)
    if (actions.length === 0) return undefined
    const moduleSpecifier = statement.moduleSpecifier
    return actions.flatMap((element) => {
      const imported = element.propertyName ?? element.name
      if (!moduleSpecifier) return exportWrapped(element.name.text, ts.factory.createIdentifier(imported.text))
      const local = ts.factory.createIdentifier(`__holoImported_${element.name.text}`)
      return [
        ts.factory.createImportDeclaration(undefined, ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
          ts.factory.createImportSpecifier(false, ts.factory.createIdentifier(imported.text), local),
        ])), moduleSpecifier),
        ...exportWrapped(element.name.text, local),
      ]
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

  let changed = false
  const statements = file.statements.slice(prologue.length).flatMap((statement) => {
    const compiled = compileStatement(statement)
    if (!compiled) return [statement]
    changed = true
    return compiled
  })
  if (!changed) return source

  const runtimeImport = ts.factory.createImportDeclaration(undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('adapterNextRuntimeInternals'), ts.factory.createIdentifier(runtimeName)),
    ])), ts.factory.createStringLiteral('@holo-js/adapter-next/runtime'))
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file, [...prologue, runtimeImport, ...statements]))
}
