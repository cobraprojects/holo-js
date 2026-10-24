import ts from 'typescript'

type RealtimeFactory = 'query' | 'mutation'

type RealtimeDefinition = {
  readonly exportedName: string
  readonly factory: RealtimeFactory
  readonly name?: string
  readonly unsafeName?: true
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

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!('name' in property) || !property.name) return undefined
  return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
    ? property.name.text
    : undefined
}

function collectRealtimeFactories(sourceFile: ts.SourceFile): ReadonlyMap<string, RealtimeFactory> {
  const factories = new Map<string, RealtimeFactory>([
    ['query', 'query'],
    ['mutation', 'mutation'],
  ])
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '@holo-js/realtime') continue
    if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName === 'query' || importedName === 'defineRealtimeQuery') {
        factories.set(element.name.text, 'query')
      } else if (importedName === 'mutation' || importedName === 'defineRealtimeMutation') {
        factories.set(element.name.text, 'mutation')
      }
    }
  }
  return factories
}

function collectDefinitions(sourceFile: ts.SourceFile): readonly RealtimeDefinition[] {
  const definitions: RealtimeDefinition[] = []
  const factories = collectRealtimeFactories(sourceFile)
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)
      || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue
      const factoryNode = declaration.initializer.expression
      if (!ts.isIdentifier(factoryNode)) continue
      const factory = factories.get(factoryNode.text)
      if (!factory) continue
      const definitionNode = declaration.initializer.arguments[0]
      if (!definitionNode || !ts.isObjectLiteralExpression(definitionNode)) continue
      const nameProperty = definitionNode.properties.find(property => propertyName(property) === 'name')
      const name = nameProperty && ts.isPropertyAssignment(nameProperty)
        ? nameProperty.initializer.getText(sourceFile)
        : undefined
      const unsafeName = nameProperty !== undefined && !(ts.isPropertyAssignment(nameProperty) && (ts.isStringLiteral(nameProperty.initializer) || ts.isNoSubstitutionTemplateLiteral(nameProperty.initializer)))
      const sourceLine = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line
      definitions.push({ exportedName: declaration.name.text, factory, sourceLine, ...(name ? { name } : {}), ...(unsafeName ? { unsafeName: true as const } : {}) })
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

export function createRealtimeClientDefinitionModule(source: string, importTarget: string, filePath: string): string {
  return createRealtimeClientDefinitionTransform(source, importTarget, filePath).code
}

export function createRealtimeClientDefinitionTransform(
  source: string,
  importTarget: string,
  filePath: string,
  options: RealtimeDefinitionTransformOptions = {},
): RealtimeDefinitionTransformResult {
  if (options.preserveServerHandlers) {
    const code = retargetRealtimeImports(source, importTarget)
    const sourceLineCount = source.split('\n').length
    return Object.freeze({
      code,
      map: createSourceMap(source, code.split('\n').map((_, index) => Math.min(index, sourceLineCount - 1))),
    })
  }

  const sourceFile = parseRealtimeSource(source)
  const definitions = collectDefinitions(sourceFile)
  if (definitions.length === 0) {
    throw new Error(`${filePath} has no query or mutation definitions, so it cannot be sent to the browser. Keep server-only code out of server/realtime, or move it out of that folder.`)
  }
  const unsafe = definitions.find(definition => definition.unsafeName)
  if (unsafe) {
    throw new Error(`${filePath} defines ${unsafe.exportedName} with a name that is not a string literal, so it cannot be sent to the browser.`)
  }
  const factories = [...new Set(definitions.map(definition => definition.factory))]
  const outputLines: string[] = [
    `import { ${factories.join(', ')} } from '${importTarget}'`,
    '',
  ]
  const sourceLines: Array<number | undefined> = [undefined, undefined]
  for (const definition of definitions) {
    outputLines.push(`export const ${definition.exportedName} = ${definition.factory}({`)
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
