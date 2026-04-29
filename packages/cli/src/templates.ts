import { dirname, relative, resolve } from 'node:path'

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export type NameParts = {
  readonly directory: string
  readonly rawBaseName: string
}

export function splitRequestedName(value: string): NameParts {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')

  if (!normalized) {
    throw new Error('A name is required.')
  }

  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new Error('Names must stay within the project root.')
  }

  const rawBaseName = segments.pop()
  /* v8 ignore next 3 */
  if (!rawBaseName) {
    throw new Error('A name is required.')
  }

  return {
    directory: segments.join('/'),
    rawBaseName,
  }
}

export function toPascalCase(value: string): string {
  return value
    .replace(/[^a-z0-9]+/gi, ' ')
    .split(' ')
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')
}

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

export function toKebabCase(value: string): string {
  return toSnakeCase(value).replaceAll('_', '-')
}

export function pluralize(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`
  }

  if (/(?:[sxz]|ch|sh)$/i.test(word)) {
    return `${word}es`
  }

  return `${word}s`
}

export function ensureSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : `${name}${suffix}`
}

export function relativeImportPath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile)
  const target = toPosixPath(relative(fromDir, toFile))
    .replace(/\.[^.]+$/, '')
  return target.startsWith('.') ? target : `./${target}`
}

export function renderModelTemplate(options: {
  tableName: string
  generatedSchemaImportPath?: string
  observerImportPath?: string
  observerClassName?: string
}): string {
  const imports = ['import { defineModel } from \'@holo-js/db\'']

  if (options.observerImportPath && options.observerClassName) {
    imports.push(`import { ${options.observerClassName} } from '${options.observerImportPath}'`)
  }

  return [
    ...imports,
    '',
    `export default defineModel(${JSON.stringify(options.tableName)}, {`,
    '  fillable: [],',
    ...(options.observerClassName ? [`  observers: [${options.observerClassName}],`] : []),
    '})',
    '',
  ].join('\n')
}

export function renderSeederTemplate(seederName: string): string {
  return [
    'import { defineSeeder } from \'@holo-js/db\'',
    '',
    'export default defineSeeder({',
    `  name: '${seederName}',`,
    '  async run({ db, schema }) {',
    '    void db',
    '    void schema',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderObserverTemplate(className: string): string {
  return [
    `export class ${className} {`,
    '  created() {}',
    '',
    '  updated() {}',
    '',
    '  deleted() {}',
    '}',
    '',
    `export default ${className}`,
    '',
  ].join('\n')
}

export function renderFactoryTemplate(modelImportPath: string, modelName: string): string {
  return [
    'import { defineFactory } from \'@holo-js/db\'',
    `import ${modelName} from '${modelImportPath}'`,
    '',
    `export default defineFactory(${modelName}, () => ({`,
    '}))',
    '',
  ].join('\n')
}

export function renderJobTemplate(): string {
  return [
    'import { defineJob } from \'@holo-js/queue\'',
    '',
    'export default defineJob({',
    '  async handle(payload, context) {',
    '    void payload',
    '    void context',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderEventTemplate(eventName: string): string {
  return [
    'import { defineEvent } from \'@holo-js/events\'',
    '',
    'export default defineEvent<Record<string, unknown>>({',
    `  name: '${eventName}',`,
    '})',
    '',
  ].join('\n')
}

export function renderBroadcastTemplate(eventName: string): string {
  return [
    'import { channel, defineBroadcast } from \'@holo-js/broadcast\'',
    '',
    'export default defineBroadcast({',
    `  name: '${eventName}',`,
    '  channels: [',
    `    channel('${eventName}'),`,
    '  ],',
    '  payload: {},',
    '})',
    '',
  ].join('\n')
}

export function renderChannelTemplate(pattern: string): string {
  return [
    'import { defineChannel } from \'@holo-js/broadcast\'',
    '',
    `export default defineChannel('${pattern}', {`,
    '  type: \'private\',',
    '  authorize() {',
    '    return false',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderListenerTemplate(eventImportStatement: string, eventName: string): string {
  return [
    'import { defineListener } from \'@holo-js/events\'',
    eventImportStatement,
    '',
    'export default defineListener({',
    `  listensTo: [${eventName}],`,
    '  async handle(event) {',
    '    void event',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderMultiListenerTemplate(
  events: readonly { importStatement: string, importName: string }[],
): string {
  return [
    'import { defineListener } from \'@holo-js/events\'',
    ...events.map(event => event.importStatement),
    '',
    'export default defineListener({',
    `  listensTo: [${events.map(event => event.importName).join(', ')}],`,
    '  async handle(event) {',
    '    void event',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function renderMarkdownMailTemplate(mailName: string, inputTypeName: string): string {
  return [
    'import { defineMail } from \'@holo-js/mail\'',
    '',
    `export type ${inputTypeName} = {`,
    '  readonly to: string',
    '  readonly name: string',
    '}',
    '',
    `function ${mailName}(input: ${inputTypeName}) {`,
    '  return defineMail({',
    '    to: input.to,',
    '    subject: `Welcome, ${input.name}`,',
    '    markdown: [',
    '      \'# Welcome\',',
    '      \'\',',
    '      `Hello ${input.name},`,',
    '      \'\',',
    '      \'Your mail definition is ready.\',',
    '    ].join(\'\\n\'),',
    '  })',
    '}',
    '',
    `export default ${mailName}`,
    '',
  ].join('\n')
}

export function renderViewMailTemplate(
  mailName: string,
  inputTypeName: string,
  viewIdentifier: string,
): string {
  return [
    'import { defineMail } from \'@holo-js/mail\'',
    '',
    `export type ${inputTypeName} = {`,
    '  readonly to: string',
    '  readonly name: string',
    '}',
    '',
    `function ${mailName}(input: ${inputTypeName}) {`,
    '  return defineMail({',
    '    to: input.to,',
    '    subject: `Welcome, ${input.name}`,',
    '    render: {',
    `      view: '${viewIdentifier}',`,
    '      props: input,',
    '    },',
    '  })',
    '}',
    '',
    `export default ${mailName}`,
    '',
  ].join('\n')
}

export function renderNextMailViewTemplate(mailName: string, inputTypeName: string, factoryImportPath: string): string {
  return [
    `import type { ${inputTypeName} } from '${factoryImportPath}'`,
    '',
    `export default function ${mailName}View(input: ${inputTypeName}) {`,
    '  return (',
    '    <div>',
    '      <h1>Welcome</h1>',
    '      <p>Hello {input.name},</p>',
    '      <p>This message is addressed to {input.to}.</p>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

export function renderNuxtMailViewTemplate(inputTypeName: string, factoryImportPath: string): string {
  return [
    '<script setup lang="ts">',
    `import type { ${inputTypeName} } from '${factoryImportPath}'`,
    '',
    `defineProps<${inputTypeName}>()`,
    '</script>',
    '',
    '<template>',
    '  <div>',
    '    <h1>Welcome</h1>',
    '    <p>Hello {{ name }},</p>',
    '    <p>This message is addressed to {{ to }}.</p>',
    '  </div>',
    '</template>',
    '',
  ].join('\n')
}

export function renderSvelteMailViewTemplate(inputTypeName: string, factoryImportPath: string): string {
  return [
    '<script lang="ts">',
    `  import type { ${inputTypeName} } from '${factoryImportPath}'`,
    '',
    `  export let to: ${inputTypeName}['to']`,
    `  export let name: ${inputTypeName}['name']`,
    '</script>',
    '',
    '<div>',
    '  <h1>Welcome</h1>',
    '  <p>Hello {name},</p>',
    '  <p>This message is addressed to {to}.</p>',
    '</div>',
    '',
  ].join('\n')
}

export function renderGenericMailViewTemplate(mailName: string, inputTypeName: string, factoryImportPath: string): string {
  return [
    `import type { ${inputTypeName} } from '${factoryImportPath}'`,
    '',
    `export default function ${mailName}View(input: ${inputTypeName}) {`,
    '  return [',
    '    \'<div>\',',
    '    \'  <h1>Welcome</h1>\',',
    '    `  <p>Hello ${input.name},</p>`,',
    '    `  <p>This message is addressed to ${input.to}.</p>`,',
    '    \'</div>\',',
    '  ].join(\'\\n\')',
    '}',
    '',
  ].join('\n')
}

export function resolveNameInfo(requestedName: string, options: { suffix?: string } = {}) {
  const parts = splitRequestedName(requestedName)
  const baseName = ensureSuffix(toPascalCase(parts.rawBaseName), options.suffix ?? '')
  const baseStem = options.suffix && baseName.endsWith(options.suffix)
    ? baseName.slice(0, -options.suffix.length)
    : baseName
  const snakeStem = toSnakeCase(baseStem)
  const tableName = pluralize(snakeStem)

  return {
    directory: parts.directory,
    baseName,
    baseStem,
    snakeStem,
    tableName,
  }
}

export function resolveArtifactPath(root: string, subdir: string, directory: string, fileName: string): string {
  return resolve(root, subdir, directory, fileName)
}
