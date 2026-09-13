import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

export async function verifyCompiledValidation({ build, directory, nodePaths, compile }) {
  const source = `import { field as f, schema as form } from '@holo-js/validation'
export const schema = form({
  email: f.string().required('Email required').email(),
  password: f.password().min(8).confirmed(),
  name: f.string().min(3).max(12),
  count: f.number().integer().min(1).max(10).default(2),
  enabled: f.boolean().default(false),
  profile: { website: f.string().url().optional(), id: f.string().uuid().nullable() },
})`
  const transformed = compile(source)
  assert.ok(transformed)
  const variants = {}
  for (const [name, contents] of Object.entries({ original: source, compiled: transformed })) {
    const result = await build({ stdin: { contents, resolveDir: directory }, bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, nodePaths })
    const output = result.outputFiles[0].contents
    const target = join(directory, `validation-${name}.mjs`)
    await writeFile(target, output)
    variants[name] = { schema: (await import(pathToFileURL(target).href)).schema, bytes: output.length, gzip: gzipSync(output).length }
  }
  assert.deepEqual(variants.compiled.schema.fields, variants.original.schema.fields)
  const valid = { email: 'reader@example.com', password: '12345678', passwordConfirmation: '12345678', name: 'Alice', profile: { id: null } }
  const inputs = [{}, valid, { ...valid, email: 'invalid' }, { ...valid, name: '  ' }, { ...valid, passwordConfirmation: 'different' }, { ...valid, count: '11' }, { ...valid, count: '3', enabled: 'on' }, { ...valid, profile: { website: 'invalid', id: 'invalid' } }, { ...valid, email: 42 }, { ...valid, count: 1.5 }, { ...valid, name: 'x'.repeat(20) }]
  for (const input of inputs) {
    assert.deepEqual(await variants.compiled.schema['~standard'].validate(input), await variants.original.schema['~standard'].validate(input), JSON.stringify(input))
  }
  assert.ok(Object.isFrozen(variants.compiled.schema.fields.email.definition.rules[0].args))
  const dynamic = `import {field,schema} from '@holo-js/validation'; const minimum = Number(globalThis.minimum); export const form = schema({name:field.string().min(minimum).custom(value => value !== 'reserved')})`
  assert.equal(compile(dynamic), undefined)
  assert.equal(compile(`import {field,schema} from '@holo-js/validation'; export const form = schema({})`), undefined)
  assert.equal(compile(`import {field,schema} from '@holo-js/validation'; export const form = schema({name:field.string(,)})`), undefined)
  for (const value of ['1e999', '-1e999', '-0']) {
    assert.equal(compile(`import {field,schema} from '@holo-js/validation'; export const form = schema({count:field.number().default(${value})})`), undefined)
  }
  const simple = `import {field,schema} from '@holo-js/validation'; export const form = schema({email:field.string().required().email()})`
  const bundled = await build({ stdin: { contents: compile(simple), resolveDir: directory }, bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, nodePaths })
  assert.doesNotMatch(bundled.outputFiles[0].text, /type:"(?:url|uuid|regex)"/)
  assert.doesNotMatch(bundled.outputFiles[0].text, /maxSize must not be empty/)
  process.stdout.write(`Packaged compiled validation: ${inputs.length} equivalent results; original ${variants.original.gzip} gzip bytes, compiled ${variants.compiled.gzip} gzip bytes\n`)
}
