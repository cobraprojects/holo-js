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

function exportHandler(wrapper: RuntimeWrapper, name: string, handler: ts.Expression): readonly ts.Statement[] {
  if (name === 'default') return [ts.factory.createExportAssignment(undefined, false, wrap(wrapper, handler))]
  const wrapped = ts.factory.createIdentifier(`__holoWrapped${name}`)
  return [
    ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
      ts.factory.createVariableDeclaration(wrapped, undefined, undefined, wrap(wrapper, handler)),
    ], ts.NodeFlags.Const)),
    ts.factory.createExportDeclaration(undefined, false, ts.factory.createNamedExports([
      ts.factory.createExportSpecifier(false, wrapped, name),
    ])),
  ]
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

function wrapExports(file: ts.SourceFile, wrapper: RuntimeWrapper, wraps: (name: string) => boolean): string | undefined {
  let changed = false
  const statements = file.statements.flatMap((statement): readonly ts.Statement[] => {
    if (ts.isFunctionDeclaration(statement) && statement.body && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text
      if (!name || !wraps(name)) return [statement]
      changed = true
      const localName = statement.name ?? ts.factory.createIdentifier('__holoOriginaldefault')
      return [ts.factory.updateFunctionDeclaration(statement,
        statement.modifiers?.filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword),
        statement.asteriskToken, localName, statement.typeParameters, statement.parameters, statement.type, statement.body,
      ), ...exportHandler(wrapper, name, localName)]
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && wraps('default')) {
      changed = true
      return exportHandler(wrapper, 'default', statement.expression)
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const declarations = statement.declarationList.declarations.map(declaration => {
        if (!ts.isIdentifier(declaration.name) || !wraps(declaration.name.text) || !declaration.initializer) return declaration
        changed = true
        return ts.factory.updateVariableDeclaration(declaration, declaration.name, declaration.exclamationToken,
          declaration.type, wrap(wrapper, declaration.initializer))
      })
      return [ts.factory.updateVariableStatement(statement, statement.modifiers,
        ts.factory.updateVariableDeclarationList(statement.declarationList, declarations))]
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const handlers = statement.exportClause.elements.filter(element => !element.isTypeOnly && wraps(element.name.text))
      if (handlers.length === 0) return [statement]
      changed = true
      const result: ts.Statement[] = []
      const remaining = statement.exportClause.elements.filter(element => !handlers.includes(element))
      if (remaining.length) result.push(ts.factory.updateExportDeclaration(statement, statement.modifiers, statement.isTypeOnly,
        ts.factory.updateNamedExports(statement.exportClause, remaining), statement.moduleSpecifier, statement.attributes))
      for (const handler of handlers) {
        const imported = handler.propertyName ?? handler.name
        const local = ts.factory.createIdentifier(statement.moduleSpecifier ? `__holoOriginal${handler.name.text}` : imported.text)
        if (statement.moduleSpecifier) result.push(ts.factory.createImportDeclaration(undefined,
          ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
            ts.factory.createImportSpecifier(false, imported, local),
          ])), statement.moduleSpecifier))
        result.push(...exportHandler(wrapper, handler.name.text, local))
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
    [...statements.slice(0, insertAt), runtimeImport, ...statements.slice(insertAt)]))
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
