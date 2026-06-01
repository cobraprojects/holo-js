import { describe, it } from 'vitest'
import { field, schema } from '../src'
import { type ClientSubmitResult, createFormClient as useForm, type FormFieldState, type UseFormResult } from '../src/internal/client'

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
      contacts: field.array({
        label: field.string().required(),
        value: field.string().required(),
      }).optional(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        age: undefined,
        tags: ['admin'],
        contacts: [{ label: 'Work', value: 'work@example.com' }],
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
        contacts: {
          label: string
          value: string
        }[] | undefined
        profile: {
          city: string
        }
      }>
    >>

    const emailField: FormFieldState<string> = client.fields.email
    const ageField: FormFieldState<number | undefined> = client.fields.age
    const tagsField: FormFieldState<string[] | undefined> = client.fields.tags
    const contactsField: FormFieldState<{ label: string, value: string }[] | undefined> = client.fields.contacts
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
    void contactsField
    void cityField
    void emailValue
    void applyServerStateResult
    void invalidField
    void (0 as unknown as ClientAssertion)
  })

  it('keeps schema-driven field inference for forms that include a name field', () => {
    const registerUser = schema({
      name: field.string().required(),
      email: field.string().required().email(),
      password: field.password().required().min(8).confirmed(),
      passwordConfirmation: field.password().required(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        name: 'Ava',
        email: 'ava@example.com',
        password: 'supersecret',
        passwordConfirmation: 'supersecret',
      },
      submitter() {
        return {
          ok: true as const,
          status: 200,
          data: {
            message: 'Account created.',
          },
        }
      },
    })

    const nameField: FormFieldState<string> = client.fields.name
    const confirmationField: FormFieldState<string> = client.fields.passwordConfirmation

    if (client.lastSubmission?.ok === true) {
      const message: string = client.lastSubmission.data.message
      void message
    }

    void nameField
    void confirmationField
  })
})
