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
  digits: f.number().digits(3, 'Three digits.').min(200).optional(),
  minDigits: f.number().minDigits(3).max(2000).optional(),
  maxDigits: f.number().maxDigits(3).optional(),
  zeroDigits: f.number().maxDigits(0).optional(),
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
  for (const value of [0, -0, 12, 123, 1234, -123, 12.3, 1e21, 1e23, 1e23 - 2 ** 24, 1e23 + 2 ** 24, Number.MAX_VALUE, NaN, Infinity, -Infinity, undefined, null, '123', '123abc']) {
    inputs.push({ ...valid, digits: value, minDigits: value, maxDigits: value, zeroDigits: value })
  }
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
  for (const name of ['digits', 'minDigits', 'maxDigits']) {
    for (const count of ['-1', '1.5', '9007199254740992', 'null', "'3'"]) {
      assert.equal(compile(`import {field,schema} from '@holo-js/validation'; export const form = schema({count:field.number().${name}(${count})})`), undefined)
    }
    assert.equal(compile(`import {field,schema} from '@holo-js/validation'; export const form = schema({count:field.string().${name}(3)})`), undefined)
  }
  const simple = `import {field,schema} from '@holo-js/validation'; export const form = schema({email:field.string().required().email()})`
  const bundled = await build({ stdin: { contents: compile(simple), resolveDir: directory }, bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, nodePaths })
  assert.doesNotMatch(bundled.outputFiles[0].text, /type:"(?:url|uuid|regex)"/)
  assert.doesNotMatch(bundled.outputFiles[0].text, /maxSize must not be empty/)
  process.stdout.write(`Packaged compiled validation: ${inputs.length} equivalent results; original ${variants.original.gzip} gzip bytes, compiled ${variants.compiled.gzip} gzip bytes\n`)
}
