import { describe, it } from 'vitest'
import { field, schema } from '../src'
import { type ClientSubmitResult, type FormFieldState, type UseFormResult, useForm } from '../src/client'

describe('@holo-js/forms client typing', () => {
  it('preserves typed fields, values, and nested field access', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const registerUser = schema({
      email: field.string().required().email(),
      age: field.number().optional(),
      tags: field.array(field.string().required()).optional(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      csrf: false,
      initialValues: {
        email: 'ava@example.com',
        age: undefined,
        tags: ['admin'],
        profile: {
          city: 'Cairo',
        },
      },
    })

    // @ts-expect-error Throttling is intentionally server-only.
    useForm(registerUser, { throttle: 'login' })

    type ClientAssertion = Expect<Equal<
      typeof client,
      UseFormResult<{
        email: string
        age: number | undefined
        tags: string[] | undefined
        profile: {
          city: string
        }
      }>
    >>

    const emailField: FormFieldState<string> = client.fields.email
    const ageField: FormFieldState<number | undefined> = client.fields.age
    const tagsField: FormFieldState<string[] | undefined> = client.fields.tags
    const cityField: FormFieldState<string> = client.fields.profile.city
    const emailValue: string = client.values.email
    const applyServerStateResult: ClientSubmitResult<{
      email: string
      age: number | undefined
      tags: string[] | undefined
      profile: {
        city: string
      }
    }> = client.applyServerState({
      ok: false,
      status: 409,
      valid: false,
      values: {
        email: 'taken@example.com',
      },
      errors: {
        email: ['Already taken.'],
      },
    })

    // @ts-expect-error Unknown field access must fail typing.
    const invalidField = client.fields.unknown

    void emailField
    void ageField
    void tagsField
    void cityField
    void emailValue
    void applyServerStateResult
    void invalidField
    void (0 as unknown as ClientAssertion)
  })
})
