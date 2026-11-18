import ts from 'typescript'

const SVELTEKIT_PLUGIN = 'sveltekit'
const CONFIG_WRAPPER = 'withHoloSvelteKit'
const CONFIG_WRAPPER_MODULE = '@holo-js/adapter-sveltekit/config'
const HOLO_VITE_PLUGIN = 'holoSvelteKit'
const LEGACY_HOLO_VITE_PLUGIN = 'holoSvelteKitRealtime'
const HOLO_VITE_MODULE = '@holo-js/adapter-sveltekit/vite'
const GENERATED_HOOKS_PATH = '.holo-js/generated/hooks'

const VITE_CONFIG_WRAP_MESSAGE = 'Could not patch vite.config.ts with withHoloSvelteKit(). Call sveltekit() in vite.config.ts so holo prepare can manage the SvelteKit integration.'
const VITE_PLUGIN_ADD_MESSAGE = 'Could not add holoSvelteKit() to vite.config.ts. Put sveltekit() directly in the plugins array so holo prepare can add the Holo plugin next to it.'
const VITE_PLUGIN_CONDITIONAL_MESSAGE = 'Could not add holoSvelteKit() to vite.config.ts. Register holoSvelteKit() unconditionally in the plugins array next to sveltekit(), because the generated hooks need it in every build.'
const LEGACY_MIGRATION_MESSAGE = 'Could not migrate holoSvelteKitRealtime in vite.config.ts. Import holoSvelteKit from @holo-js/adapter-sveltekit/vite, call holoSvelteKit() in the plugins array next to sveltekit(), and remove other uses of holoSvelteKitRealtime.'
const MULTIPLE_SVELTEKIT_MESSAGE = 'Could not patch vite.config.ts because it calls sveltekit() more than once. Call sveltekit() once in the plugins array so every build uses the same plugins.'
const CUSTOM_HOOKS_MESSAGE = 'Custom SvelteKit hook entrypoints are not supported. Remove files.hooks from the sveltekit() options and let holo prepare manage the generated hook bridge.'

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface NamedImport {
  readonly declaration: ts.ImportDeclaration
  readonly bindings: ts.NamedImports
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('vite.config.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function applyEdits(source: string, edits: readonly Edit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start || right.end - left.end)
    .reduce((patched, edit) => `${patched.slice(0, edit.start)}${edit.text}${patched.slice(edit.end)}`, source)
}

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = []
  const visit = (child: ts.Node): void => {
    nodes.push(child)
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return nodes
}

function namedImportsFrom(sourceFile: ts.SourceFile, moduleName: string): NamedImport[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== moduleName) return []
    const bindings = statement.importClause?.namedBindings
    return bindings && ts.isNamedImports(bindings) ? [{ declaration: statement, bindings }] : []
  })
}

function importedName(element: ts.ImportSpecifier): string {
  return (element.propertyName ?? element.name).text
}

function isTypeOnly(namedImport: NamedImport, element: ts.ImportSpecifier): boolean {
  return namedImport.declaration.importClause?.isTypeOnly === true || element.isTypeOnly
}

function localBindings(imports: readonly NamedImport[], exportName: string): string[] {
  return imports.flatMap(namedImport => namedImport.bindings.elements
    .filter(element => !isTypeOnly(namedImport, element) && importedName(element) === exportName)
    .map(element => element.name.text))
}

function isCallTo(node: ts.Node, names: readonly string[]): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.includes(node.expression.text)
}

function legacyReferenceEdits(sourceFile: ts.SourceFile, renamesReferences: boolean): Edit[] {
  if (!renamesReferences) return []
  const references = descendants(sourceFile)
    .filter((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === LEGACY_HOLO_VITE_PLUGIN && !ts.isImportSpecifier(node.parent))
  if (references.some(node => !ts.isCallExpression(node.parent) || node.parent.expression !== node)) throw new Error(LEGACY_MIGRATION_MESSAGE)
  return references.map(node => ({ start: node.getStart(sourceFile), end: node.end, text: HOLO_VITE_PLUGIN }))
}

function renderSpecifier(element: ts.ImportSpecifier, imported: string, local: string): string {
  const name = imported === local ? imported : `${imported} as ${local}`
  return element.isTypeOnly ? `type ${name}` : name
}

function renderNamedImports(specifiers: readonly string[]): string {
  return `{ ${[...new Set(specifiers)].join(', ')} }`
}

function migrateLegacyPlugin(source: string): string {
  const sourceFile = parse(source)
  const imports = namedImportsFrom(sourceFile, HOLO_VITE_MODULE)
  const edits: Edit[] = imports
    .filter(({ bindings }) => bindings.elements.some(element => importedName(element) === LEGACY_HOLO_VITE_PLUGIN))
    .map(({ bindings }) => ({
      start: bindings.getStart(sourceFile),
      end: bindings.end,
      text: renderNamedImports(bindings.elements.map((element) => {
        const local = element.name.text === LEGACY_HOLO_VITE_PLUGIN ? HOLO_VITE_PLUGIN : element.name.text
        return renderSpecifier(element, importedName(element) === LEGACY_HOLO_VITE_PLUGIN ? HOLO_VITE_PLUGIN : importedName(element), local)
      })),
    }))
  const renamesReferences = imports.some(({ bindings }) => bindings.elements.some(element => element.name.text === LEGACY_HOLO_VITE_PLUGIN))
  return applyEdits(source, [...edits, ...legacyReferenceEdits(sourceFile, renamesReferences)])
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined
}

function overridesHooks(options: ts.Node): boolean {
  return descendants(options).some(node => ts.isPropertyAssignment(node)
    && propertyName(node.name) === 'files'
    && ts.isObjectLiteralExpression(node.initializer)
    && node.initializer.properties.some(property => property.name !== undefined && propertyName(property.name) === 'hooks'))
}

function assertNoCustomHookOverride(source: string, call: ts.CallExpression): void {
  const options = call.arguments[0]
  if (!options || source.slice(options.pos, options.end).includes(GENERATED_HOOKS_PATH)) return
  if (overridesHooks(options)) throw new Error(CUSTOM_HOOKS_MESSAGE)
}

function wrapperEdit(source: string, call: ts.CallExpression): Edit | undefined {
  const [options] = call.arguments
  if (options && isCallTo(options, [CONFIG_WRAPPER])) return undefined
  const start = call.arguments.pos
  const end = call.end - 1
  return { start, end, text: `${CONFIG_WRAPPER}(${source.slice(start, end)})` }
}

function pluginEdit(sourceFile: ts.SourceFile, call: ts.CallExpression, bindings: readonly string[]): Edit | undefined {
  const plugins = call.parent
  const registeredInPlugins = ts.isArrayLiteralExpression(plugins) && plugins.elements.some(element => isCallTo(element, bindings))
  if (registeredInPlugins) return undefined
  if (descendants(sourceFile).some(node => isCallTo(node, bindings))) throw new Error(VITE_PLUGIN_CONDITIONAL_MESSAGE)
  if (!ts.isArrayLiteralExpression(plugins)) throw new Error(VITE_PLUGIN_ADD_MESSAGE)
  return { start: call.end, end: call.end, text: `, ${bindings[0] ?? HOLO_VITE_PLUGIN}()` }
}

function importLine(specifier: string, moduleName: string): string {
  return `import { ${specifier} } from '${moduleName}'\n`
}

function importsPluginAsType(namedImport: NamedImport): boolean {
  return namedImport.bindings.elements.some(element => isTypeOnly(namedImport, element) && element.name.text === HOLO_VITE_PLUGIN)
}

function pluginImportEdit(sourceFile: ts.SourceFile, target: NamedImport): Edit {
  const typeOnlyDeclaration = target.declaration.importClause?.isTypeOnly === true
  const specifiers = target.bindings.elements
    .filter(element => !(isTypeOnly(target, element) && element.name.text === HOLO_VITE_PLUGIN))
    .map(element => typeOnlyDeclaration ? `type ${element.getText(sourceFile)}` : element.getText(sourceFile))
  const defaultImport = target.declaration.importClause?.name
  const clause = `${defaultImport ? `${defaultImport.text}, ` : ''}${renderNamedImports([HOLO_VITE_PLUGIN, ...specifiers])}`
  return { start: target.declaration.getStart(sourceFile), end: target.bindings.end, text: `import ${clause}` }
}

function importEdits(sourceFile: ts.SourceFile): Edit[] {
  const viteImports = namedImportsFrom(sourceFile, HOLO_VITE_MODULE)
  const hasPluginBinding = localBindings(viteImports, HOLO_VITE_PLUGIN).length > 0
  const hasWrapper = namedImportsFrom(sourceFile, CONFIG_WRAPPER_MODULE)
    .some(({ declaration, bindings }) => declaration.importClause?.isTypeOnly !== true
      && bindings.elements.some(element => !element.isTypeOnly && element.propertyName === undefined && element.name.text === CONFIG_WRAPPER))
  const target = viteImports.find(importsPluginAsType) ?? viteImports.find(({ declaration }) => declaration.importClause?.isTypeOnly !== true)
  const firstImport = sourceFile.statements.find(ts.isImportDeclaration)
  const insertAt = firstImport ? firstImport.getStart(sourceFile) : 0
  const lines = [
    ...(hasWrapper ? [] : [importLine(CONFIG_WRAPPER, CONFIG_WRAPPER_MODULE)]),
    ...(hasPluginBinding || target ? [] : [importLine(HOLO_VITE_PLUGIN, HOLO_VITE_MODULE)]),
  ]
  const edits: Edit[] = lines.length > 0 ? [{ start: insertAt, end: insertAt, text: lines.join('') }] : []
  return hasPluginBinding || !target ? edits : [...edits, pluginImportEdit(sourceFile, target)]
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent
  return (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent))
    && parent.name === node
}

function assertNoShadowedBinding(sourceFile: ts.SourceFile, names: readonly string[]): void {
  const shadowed = descendants(sourceFile).find((node): node is ts.Identifier => ts.isIdentifier(node) && names.includes(node.text) && isDeclarationName(node))
  if (shadowed) throw new Error(`Could not patch vite.config.ts because a local declaration named ${shadowed.text} shadows the holoSvelteKit import. Rename the local declaration.`)
}

export function patchSvelteKitViteConfig(original: string): string {
  const source = migrateLegacyPlugin(original)
  const sourceFile = parse(source)
  const [call, ...extraCalls] = descendants(sourceFile).filter((node): node is ts.CallExpression => isCallTo(node, [SVELTEKIT_PLUGIN]))
  if (!call) throw new Error(VITE_CONFIG_WRAP_MESSAGE)
  if (extraCalls.length > 0) throw new Error(MULTIPLE_SVELTEKIT_MESSAGE)
  assertNoCustomHookOverride(source, call)
  const bindings = localBindings(namedImportsFrom(sourceFile, HOLO_VITE_MODULE), HOLO_VITE_PLUGIN)
  assertNoShadowedBinding(sourceFile, bindings.length > 0 ? bindings : [HOLO_VITE_PLUGIN])
  const edits = [wrapperEdit(source, call), pluginEdit(sourceFile, call, bindings), ...importEdits(sourceFile)]
  return applyEdits(source, edits.filter((edit): edit is Edit => edit !== undefined))
}
