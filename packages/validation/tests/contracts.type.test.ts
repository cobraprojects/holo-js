import { describe, it } from 'vitest'
import {
  type InferSchemaData,
  type StandardSchemaV1,
  type ValidationErrorBag,
  field,
  schema,
} from '../src'

describe('@holo-js/validation typing', () => {
  it('preserves schema data and error inference through schema-owned type handles', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const registerUser = schema({
      name: field.string().required().min(3),
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      newsletter: field.boolean().default(false),
      tags: field.array(field.string().required()).optional(),
      profile: {
        city: field.string().required(),
      },
    })

    type RegisterUserData = typeof registerUser.$data
    type RegisterUserErrors = typeof registerUser.$errors
    type ManualData = InferSchemaData<typeof registerUser.fields>

    type DataAssertion = Expect<Equal<
      RegisterUserData,
      {
        name: string
        email: string
        age: number | undefined
        newsletter: boolean
        tags: string[] | undefined
        profile: {
          city: string
        }
      } | undefined
    >>

    type ManualAssertion = Expect<Equal<RegisterUserData, ManualData | undefined>>
    type ErrorAssertion = Expect<Equal<RegisterUserErrors, ValidationErrorBag<ManualData> | undefined>>

    // Schema implements StandardSchemaV1
    const _standard: StandardSchemaV1<unknown, ManualData> = registerUser

    // Field builder implements StandardSchemaV1
    const emailField = field.string().required().email()
    const _fieldStandard: StandardSchemaV1<unknown, string> = emailField

    const data: ManualData = {
      name: 'Ava',
      email: 'ava@example.com',
      age: undefined,
      newsletter: false,
      tags: ['admin'],
      profile: {
        city: 'Cairo',
      },
    }

    void data
    void _standard
    void _fieldStandard
    void (0 as unknown as DataAssertion)
    void (0 as unknown as ManualAssertion)
    void (0 as unknown as ErrorAssertion)

    if (false) {
      // @ts-expect-error Invalid field kinds must not be accepted inside schema definitions.
      schema({ broken: 42 })
    }
  })
})
