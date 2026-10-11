import ts from 'typescript'

const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'])
const runtimeName = '__holoRouteRuntime'

function wrap(handler: ts.Expression): ts.CallExpression {
  return ts.factory.createCallExpression(
    ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier(runtimeName), 'routeHandler'),
    undefined,
    [handler],
  )
}

function exportHandler(name: string, handler: ts.Expression): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
    ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(name, undefined, undefined, wrap(handler)),
    ], ts.NodeFlags.Const),
  )
}

export function compileNextRoute(source: string, filename: string): string {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let changed = false
  const statements = file.statements.flatMap((statement): readonly ts.Statement[] => {
    if (ts.isFunctionDeclaration(statement)
      && statement.name && METHODS.has(statement.name.text)
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      changed = true
      const name = statement.name.text
      const localName = ts.factory.createIdentifier(`__holoOriginal${name}`)
      return [ts.factory.updateFunctionDeclaration(statement,
        statement.modifiers.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword),
        statement.asteriskToken, localName, statement.typeParameters, statement.parameters, statement.type, statement.body,
      ), exportHandler(name, localName)]
    }
    if (ts.isVariableStatement(statement)
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      const declarations = statement.declarationList.declarations.map(declaration => {
        if (!ts.isIdentifier(declaration.name) || !METHODS.has(declaration.name.text) || !declaration.initializer) return declaration
        changed = true
        return ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken,
          declaration.type, wrap(declaration.initializer))
      })
      return [ts.factory.updateVariableStatement(statement, statement.modifiers,
        ts.factory.updateVariableDeclarationList(statement.declarationList, declarations))]
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const handlers = statement.exportClause.elements.filter(element => METHODS.has(element.name.text))
      if (handlers.length === 0) return [statement]
      changed = true
      const result: ts.Statement[] = []
      const remaining = statement.exportClause.elements.filter(element => !METHODS.has(element.name.text))
      if (remaining.length) result.push(ts.factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly,
        ts.factory.updateNamedExports(statement.exportClause, remaining), statement.moduleSpecifier, statement.attributes))
      for (const handler of handlers) {
        const imported = handler.propertyName ?? handler.name
        const local = ts.factory.createIdentifier(statement.moduleSpecifier ? `__holoOriginal${handler.name.text}` : imported.text)
        if (statement.moduleSpecifier) result.push(ts.factory.createImportDeclaration(undefined,
          ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
            ts.factory.createImportSpecifier(false, imported, local),
          ])), statement.moduleSpecifier))
        result.push(exportHandler(handler.name.text, local))
      }
      return result
    }
    return [statement]
  })
  if (!changed) return source
  const runtimeImport = ts.factory.createImportDeclaration(undefined,
    ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('adapterNextRuntimeInternals'), ts.factory.createIdentifier(runtimeName)),
    ])), ts.factory.createStringLiteral('@holo-js/adapter-next/runtime'))
  return ts.createPrinter().printFile(ts.factory.updateSourceFile(file, [runtimeImport, ...statements]))
}
