import ts from 'typescript'

type Literal = string | number | boolean | null

type Rule = {
  readonly name: string
  readonly args: readonly Literal[]
  readonly message?: string
}

type Definition = {
  readonly kind: string
  readonly rules: readonly Rule[]
  readonly sensitive?: true
}

type CompiledField = {
  readonly definition: Definition
  readonly code: string
}

const primitives = new Set(['string', 'password', 'number', 'boolean', 'date'])
const flags = new Set(['required', 'optional', 'nullable', 'confirmed', 'today', 'beforeToday', 'todayOrBefore', 'beforeOrToday', 'afterToday', 'todayOrAfter', 'afterOrToday'])
const formats = new Set(['email', 'url', 'uuid', 'integer'])

function literal(node: ts.Expression): Literal | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text)
    return Number.isFinite(value) ? value : undefined
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    const value = -Number(node.operand.text)
    return Object.is(value, -0) || !Number.isFinite(value) ? undefined : value
  }
  return undefined
}

function parseRule(name: string, nodes: readonly ts.Expression[]): Rule | undefined {
  const values = nodes.map(literal)
  if (values.some(value => value === undefined)) return undefined
  const args = values as Literal[]
  const noArgument = flags.has(name) || formats.has(name)
  const numeric = name === 'min' || name === 'max' || name === 'size'
  if (!noArgument && !numeric && name !== 'default') return undefined
  if (args.length > (noArgument ? 1 : 2)) return undefined
  if (numeric && (typeof args[0] !== 'number' || !Number.isFinite(args[0]))) return undefined
  if (name === 'default' && args.length === 0) return undefined
  const message = args[noArgument ? 0 : 1]
  if (message !== undefined && (typeof message !== 'string' || !message.trim())) return undefined
  return {
    name,
    args: noArgument ? [] : args.slice(0, 1),
    ...(typeof message === 'string' ? { message: message.trim() } : {}),
  }
}

function compileField(node: ts.Expression, fieldName: string, runtime: string, definitionReference: string): CompiledField | undefined {
  const rules: Rule[] = []
  let current = node
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const member = current.expression
    if (ts.isIdentifier(member.expression) && member.expression.text === fieldName) {
      if (!primitives.has(member.name.text) || current.arguments.length !== 0) return undefined
      const kind = member.name.text === 'password' ? 'string' : member.name.text
      const definition: Definition = {
        kind,
        rules: rules.reverse(),
        ...(member.name.text === 'password' ? { sensitive: true } : {}),
      }
      const actions: string[] = []
      for (const rule of definition.rules) {
        if (formats.has(rule.name)) actions.push(`${runtime}.${rule.name}Action(${JSON.stringify(rule.message)})`)
        if (rule.name === 'min' || rule.name === 'max' || rule.name === 'size') {
          const action = rule.name === 'size' ? 'exactSizeAction' : `${rule.name}Action`
          actions.push(`${runtime}.${action}(${definitionReference}, ${JSON.stringify(rule.args[0])}, ${JSON.stringify(rule.message)})`)
        }
      }
      let code = `${runtime}.${kind}Schema()`
      if (actions.length > 0) code = `${runtime}.pipeAsync(${code}, ${actions.join(', ')})`
      const defaultRule = definition.rules.find(rule => rule.name === 'default')
      const defaultValue = defaultRule ? JSON.stringify(defaultRule.args[0]) : 'undefined'
      if (definition.rules.some(rule => rule.name === 'nullable')) code = `${runtime}.nullable(${code}, ${defaultValue})`
      if (defaultRule || definition.rules.some(rule => rule.name === 'optional')) code = `${runtime}.optional(${code}, ${defaultValue})`
      return { definition, code }
    }
    const rule = parseRule(member.name.text, current.arguments)
    if (!rule) return undefined
    rules.push(rule)
    current = member.expression
  }
  return undefined
}

function compileShape(node: ts.ObjectLiteralExpression, fieldName: string, runtime: string, path = 'fields'): { fields: string; code: string } | undefined {
  if (node.properties.length === 0) return undefined
  const fields: string[] = []
  const schemas: string[] = []
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) return undefined
    const key = property.name.text
    if (!key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key)) return undefined
    if (ts.isObjectLiteralExpression(property.initializer)) {
      const nested = compileShape(property.initializer, fieldName, runtime, `${path}[${JSON.stringify(key)}]`)
      if (!nested) return undefined
      fields.push(`${JSON.stringify(key)}: ${nested.fields}`)
      schemas.push(`${JSON.stringify(key)}: ${nested.code}`)
      continue
    }
    const field = compileField(property.initializer, fieldName, runtime, `${path}[${JSON.stringify(key)}].definition`)
    if (!field) return undefined
    const rules = field.definition.rules.map(rule => `Object.freeze({name: ${JSON.stringify(rule.name)}, args: Object.freeze(${JSON.stringify(rule.args)})${rule.message ? `, message: ${JSON.stringify(rule.message)}` : ''}})`)
    fields.push(`${JSON.stringify(key)}: Object.freeze({kind: 'field', definition: Object.freeze({kind: ${JSON.stringify(field.definition.kind)}, item: undefined, ${field.definition.sensitive ? 'sensitive: true,' : ''} rules: Object.freeze([${rules.join(',')}])})})`)
    schemas.push(`${JSON.stringify(key)}: ${field.code}`)
  }
  return { fields: `Object.freeze({${fields.join(',')}})`, code: `${runtime}.objectAsync({${schemas.join(',')}})` }
}

export function compileBrowserValidation(source: string, fileName = 'schema.tsx'): string | undefined {
  if (!source.includes('@holo-js/validation')) return undefined
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const diagnostics = ts.transpileModule(source, { fileName, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve } }).diagnostics
  if (diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) return undefined
  let fieldName: string | undefined
  const schemaNames = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const packageName = statement.moduleSpecifier.text
    if (packageName !== '@holo-js/validation') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue
    for (const binding of bindings.elements) {
      if (binding.isTypeOnly) continue
      const name = binding.propertyName?.text ?? binding.name.text
      if (name === 'field') fieldName = binding.name.text
      if (name === 'schema' || name === 'defineSchema') schemaNames.add(binding.name.text)
    }
  }
  if (!fieldName || schemaNames.size === 0) return undefined
  let runtime = '__holoValidation'
  while (source.includes(runtime)) runtime += '_'
  const replacements: { start: number; end: number; code: string }[] = []
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer
      if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !schemaNames.has(call.expression.text) || call.arguments.length !== 1) continue
      const shape = call.arguments[0]
      if (!shape || !ts.isObjectLiteralExpression(shape)) continue
      const compiled = compileShape(shape, fieldName, runtime)
      if (!compiled) continue
      const code = `(() => { const fields = ${compiled.fields}; const compiled = ${compiled.code}; return Object.freeze({kind: 'schema', fields, '~standard': {version: 1, vendor: 'holo-js', validate: ${runtime}.createSchemaStandardValidate(fields, () => compiled), types: undefined}}) })()`
      replacements.push({ start: call.getStart(file), end: call.end, code })
    }
  }
  if (replacements.length === 0) return undefined
  let output = source
  for (const replacement of replacements.reverse()) output = output.slice(0, replacement.start) + replacement.code + output.slice(replacement.end)
  return `${output}\nimport * as ${runtime} from '@holo-js/validation/internal/compiled'\n`
}
