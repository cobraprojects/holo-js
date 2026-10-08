import { expectTypeOf, it } from 'vitest'
import { field, parse, schema } from '@holo-js/validation'
import { safeParse } from '../src'

it('infers transformed nested output through Validation and Forms', () => {
  const definition = schema({
    rows: field.array({
      length: field.string().default('Ava').transform(value => value.length)
        .custom(value => {
          expectTypeOf(value).toEqualTypeOf<number>()
          return value > 0
        }),
    }),
    note: field.string().optional(),
  })
  type Data = { rows: { length: number }[]; note: string | undefined }

  expectTypeOf(definition.$data).toEqualTypeOf<Data | undefined>()

  async function checkConsumers() {
    const input = { rows: [{}] }
    expectTypeOf(await parse(input, definition)).toEqualTypeOf<Data>()

    const standard = await definition['~standard'].validate(input)
    if (!standard.issues) expectTypeOf(standard.value).toEqualTypeOf<Data>()

    const submission = await safeParse(input, definition)
    if (submission.valid) expectTypeOf(submission.data).toEqualTypeOf<Data>()
    else expectTypeOf(submission.values).toEqualTypeOf<Partial<Data>>()
  }

  void checkConsumers
})
