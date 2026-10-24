import ts from 'typescript'

type RealtimeFactory = 'query' | 'mutation'

type RealtimeDefinition = {
  readonly exportedName: string
  readonly factory: RealtimeFactory
  readonly name?: string
  readonly sourceLine: number
}

export type RealtimeDefinitionSourceMap = {
  readonly version: 3
  readonly file: string
  readonly sources: readonly string[]
  readonly sourcesContent: readonly string[]
  readonly names: readonly string[]
  readonly mappings: string
}

export type RealtimeDefinitionTransformResult = {
  readonly code: string
  readonly map: RealtimeDefinitionSourceMap
}

export type RealtimeDefinitionTransformOptions = {
  readonly preserveServerHandlers?: boolean
}

export type RealtimeDefinitionTransformInput = RealtimeDefinitionTransformOptions & {
  readonly source: string
  readonly importTarget: string
  readonly filePath: string
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!('name' in property) || !property.name) return undefined
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : undefined
}

const realtimeFactoryExports: ReadonlyMap<string, RealtimeFactory> = new Map([
  ['query', 'query'],
  ['mutation', 'mutation'],
  ['defineRealtimeQuery', 'query'],
  ['defineRealtimeMutation', 'mutation'],
])

type RealtimeBindings = {
  readonly factories: ReadonlyMap<string, RealtimeFactory>
  readonly namespaces: ReadonlySet<string>
  readonly aliases: ReadonlySet<string>
}

type DefinitionName =
  | { readonly known: true, readonly literal?: ts.StringLiteralLike }
  | { readonly known: false }

function referenceRoot(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrapExpression(expression)
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression)
  }
  return ts.isIdentifier(current) ? current : undefined
}

function boundNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap(element => ts.isBindingElement(element) ? boundNames(element.name) : [])
}

function collectRealtimeBindings(sourceFile: ts.SourceFile): RealtimeBindings {
  const factories = new Map<string, RealtimeFactory>([
    ['query', 'query'],
    ['mutation', 'mutation'],
  ])
  const namespaces = new Set<string>()
  const aliases = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@holo-js/realtime') continue
    const { name, namedBindings } = statement.importClause
    if (name) namespaces.add(name.text)
    if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.add(namedBindings.name.text)
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) continue
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 'default') {
        namespaces.add(element.name.text)
        continue
      }
      const factory = realtimeFactoryExports.get(importedName)
      if (factory) factories.set(element.name.text, factory)
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const root = declaration.initializer && referenceRoot(declaration.initializer)
      if (root && (factories.has(root.text) || namespaces.has(root.text) || aliases.has(root.text))) {
        for (const name of boundNames(declaration.name)) aliases.add(name)
      }
    }
  }
  return { factories, namespaces, aliases }
}

function namespaceMember(callee: ts.Expression, bindings: RealtimeBindings): string | undefined {
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined
  if (!ts.isIdentifier(callee.expression) || !bindings.namespaces.has(callee.expression.text)) return undefined
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined
}

function resolveFactory(callee: ts.Expression, bindings: RealtimeBindings): RealtimeFactory | undefined {
  if (ts.isIdentifier(callee)) return bindings.factories.get(callee.text)
  const member = namespaceMember(callee, bindings)
  return member === undefined ? undefined : realtimeFactoryExports.get(member)
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression
  }
  return current
}

function containsFactoryCall(node: ts.Node, bindings: RealtimeBindings): boolean {
  if (ts.isCallExpression(node)) {
    const root = referenceRoot(node.expression)
    if (resolveFactory(node.expression, bindings) || (root && bindings.aliases.has(root.text))) return true
  }
  return ts.forEachChild(node, child => containsFactoryCall(child, bindings) || undefined) ?? false
}

function collectStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, ts.StringLiteralLike> {
  const constants = new Map<string, ts.StringLiteralLike>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)) {
        constants.set(declaration.name.text, declaration.initializer)
      }
    }
  }
  return constants
}

function definitionKey(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined
  if (ts.isComputedPropertyName(property.name)) {
    const expression = unwrapExpression(property.name.expression)
    return ts.isStringLiteralLike(expression) ? expression.text : undefined
  }
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
    ? property.name.text
    : undefined
}

function definitionNameValue(property: ts.ObjectLiteralElementLike, constants: ReadonlyMap<string, ts.StringLiteralLike>): DefinitionName {
  const value = ts.isShorthandPropertyAssignment(property)
    ? property.name
    : ts.isPropertyAssignment(property) ? unwrapExpression(property.initializer) : undefined
  const literal = value && (ts.isStringLiteralLike(value) ? value : ts.isIdentifier(value) ? constants.get(value.text) : undefined)
  return literal ? { known: true, literal } : { known: false }
}

function resolveDefinitionName(definitionNode: ts.ObjectLiteralExpression, constants: ReadonlyMap<string, ts.StringLiteralLike>): DefinitionName {
  let name: DefinitionName = { known: true }
  for (const property of definitionNode.properties) {
    if (ts.isSpreadAssignment(property)) {
      name = { known: false }
      continue
    }
    const key = definitionKey(property)
    if (key === 'name') {
      name = definitionNameValue(property, constants)
    } else if (key === undefined && property.name && ts.isComputedPropertyName(property.name)) {
      name = { known: false }
    }
  }
  return name
}

function unreducibleDefinitionError(filePath: string, exportedName: string): Error {
  return new Error(`${filePath} exports ${exportedName} through a query or mutation call that cannot be reduced to a browser definition. Export each definition directly, as export const name = query({ name: 'posts.list', ... }) or export default query({ ... }).`)
}

function collectDefinitions(sourceFile: ts.SourceFile, filePath: string): readonly RealtimeDefinition[] {
  const definitions: RealtimeDefinition[] = []
  const bindings = collectRealtimeBindings(sourceFile)
  const constants = collectStringConstants(sourceFile)
  const definitionLocals = new Set<string>()

  const recordDefinition = (exportedName: string, expression: ts.Expression, node: ts.Node): boolean => {
    const call = unwrapExpression(expression)
    const factory = ts.isCallExpression(call) ? resolveFactory(call.expression, bindings) : undefined
    if (!ts.isCallExpression(call) || !factory) {
      if (containsFactoryCall(expression, bindings)) throw unreducibleDefinitionError(filePath, exportedName)
      return false
    }
    const definitionNode = call.arguments[0]
    if (!definitionNode || !ts.isObjectLiteralExpression(definitionNode)) throw unreducibleDefinitionError(filePath, exportedName)
    const name = resolveDefinitionName(definitionNode, constants)
    if (!name.known) {
      throw new Error(`${filePath} defines ${exportedName} with a name that is not a string literal, so it cannot be sent to the browser.`)
    }
    const sourceLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
    definitions.push({ exportedName, factory, sourceLine, ...(name.literal ? { name: name.literal.getText(sourceFile) } : {}) })
    return true
  }

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) continue
        if (!exported) {
          if (ts.isIdentifier(declaration.name) && containsFactoryCall(declaration.initializer, bindings)) {
            definitionLocals.add(declaration.name.text)
          }
          continue
        }
        if (!ts.isIdentifier(declaration.name)) {
          if (containsFactoryCall(declaration.initializer, bindings)) throw unreducibleDefinitionError(filePath, declaration.name.getText(sourceFile))
          continue
        }
        if (recordDefinition(declaration.name.text, declaration.initializer, declaration)) definitionLocals.add(declaration.name.text)
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const root = referenceRoot(statement.expression)
      if (root && definitionLocals.has(root.text)) throw unreducibleDefinitionError(filePath, 'default')
      recordDefinition('default', statement.expression, statement)
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.text ?? element.name.text
        if (!element.isTypeOnly && definitionLocals.has(localName)) throw unreducibleDefinitionError(filePath, element.name.text)
      }
    }
  }
  return Object.freeze(definitions)
}

const base64VlqCharacters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeVlq(value: number): string {
  let encoded = ''
  let remaining = value < 0 ? ((-value) << 1) + 1 : value << 1
  do {
    let digit = remaining & 31
    remaining >>>= 5
    if (remaining > 0) digit |= 32
    encoded += base64VlqCharacters[digit]
  } while (remaining > 0)
  return encoded
}

function createSourceMap(source: string, sourceLines: readonly (number | undefined)[]): RealtimeDefinitionSourceMap {
  let previousSourceLine = 0
  const mappings = sourceLines.map((sourceLine) => {
    if (typeof sourceLine === 'undefined') return ''
    const segment = `${encodeVlq(0)}${encodeVlq(0)}${encodeVlq(sourceLine - previousSourceLine)}${encodeVlq(0)}`
    previousSourceLine = sourceLine
    return segment
  }).join(';')

  return {
    version: 3 as const,
    file: 'realtime.client.ts',
    sources: ['realtime.ts'],
    sourcesContent: [source],
    names: [],
    mappings,
  }
}

function parseRealtimeSource(source: string): ts.SourceFile {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    reportDiagnostics: true,
  })
  const diagnostic = result.diagnostics?.find(entry => entry.category === ts.DiagnosticCategory.Error)
  if (diagnostic) {
    throw new SyntaxError(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  }
  return ts.createSourceFile('realtime.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function retargetRealtimeImports(source: string, importTarget: string): string {
  const sourceFile = parseRealtimeSource(source)
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => (root) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isImportDeclaration(node)
        && ts.isStringLiteral(node.moduleSpecifier)
        && node.moduleSpecifier.text === '@holo-js/realtime') {
        return ts.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          ts.factory.createStringLiteral(importTarget),
          node.attributes,
        )
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit) as ts.SourceFile
  }
  const result = ts.transform(sourceFile, [transformer])
  try {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0] as ts.SourceFile)
  } finally {
    result.dispose()
  }
}

export function stripRealtimeServerHandlers(source: string): string {
  const sourceFile = parseRealtimeSource(source)
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => (root) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isPropertyAssignment(node) && (propertyName(node) === 'handler' || propertyName(node) === 'authorize')) {
        return ts.factory.updatePropertyAssignment(node, node.name, ts.factory.createIdentifier('undefined'))
      }
      if (ts.isMethodDeclaration(node) && (propertyName(node) === 'handler' || propertyName(node) === 'authorize')) {
        return ts.factory.createPropertyAssignment(node.name, ts.factory.createIdentifier('undefined'))
      }
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(root, visit) as ts.SourceFile
  }
  const result = ts.transform(sourceFile, [transformer])
  try {
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(result.transformed[0] as ts.SourceFile)
  } finally {
    result.dispose()
  }
}

export function createRealtimeClientDefinitionModule(input: Omit<RealtimeDefinitionTransformInput, 'preserveServerHandlers'>): string {
  return createRealtimeClientDefinitionTransform(input).code
}

export function createRealtimeClientDefinitionTransform(input: RealtimeDefinitionTransformInput): RealtimeDefinitionTransformResult {
  if (typeof input !== 'object' || input === null || typeof input.source !== 'string' || typeof input.importTarget !== 'string' || typeof input.filePath !== 'string') {
    throw new TypeError('createRealtimeClientDefinitionTransform takes one object with source, importTarget, and filePath strings, and an optional preserveServerHandlers flag.')
  }
  const { source, importTarget, filePath } = input
  if (input.preserveServerHandlers) {
    const code = retargetRealtimeImports(source, importTarget)
    const sourceLineCount = source.split('\n').length
    return Object.freeze({
      code,
      map: createSourceMap(source, code.split('\n').map((_, index) => Math.min(index, sourceLineCount - 1))),
    })
  }

  const sourceFile = parseRealtimeSource(source)
  const definitions = collectDefinitions(sourceFile, filePath)
  if (definitions.length === 0) {
    throw new Error(`${filePath} has no query or mutation definitions, so it cannot be sent to the browser. Keep server-only code out of server/realtime, or move it out of that folder.`)
  }
  const factories = [...new Set(definitions.map(definition => definition.factory))]
  const outputLines: string[] = [
    `import { ${factories.join(', ')} } from '${importTarget}'`,
    '',
  ]
  const sourceLines: Array<number | undefined> = [undefined, undefined]
  for (const definition of definitions) {
    outputLines.push(definition.exportedName === 'default'
      ? `export default ${definition.factory}({`
      : `export const ${definition.exportedName} = ${definition.factory}({`)
    sourceLines.push(definition.sourceLine)
    if (definition.name) {
      outputLines.push(`  name: ${definition.name},`)
      sourceLines.push(definition.sourceLine)
    }
    outputLines.push('  handler: undefined,', '})', '')
    sourceLines.push(definition.sourceLine, definition.sourceLine, undefined)
  }

  return Object.freeze({
    code: outputLines.join('\n'),
    map: createSourceMap(source, sourceLines),
  })
}

export { compileBrowserValidation } from './validation-transform'
export { compileNextRoute } from './next-route-transform'
