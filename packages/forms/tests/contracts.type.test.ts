import { describe, it } from 'vitest'
import {
  type FormSubmissionFailure,
  type FormSubmissionSuccess,
  type FormRequestLikeInput,
  createFailedSubmission,
  createSuccessfulSubmission,
  field,
  schema,
  validate,
} from '../src'

describe('@holo-js/forms typing', () => {
  it('preserves schema-owned type handles and submission result inference', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const registerUser = schema({
      name: field.string().required(),
      email: field.string().required().email(),
      age: field.number().optional(),
    })

    type RegisterUserData = typeof registerUser.$data
    type RegisterUserErrors = typeof registerUser.$errors
    type Success = ReturnType<typeof createSuccessfulSubmission<typeof registerUser.fields, typeof registerUser>>
    type Failure = ReturnType<typeof createFailedSubmission<typeof registerUser.fields, typeof registerUser>>
    type SubmitResult = Awaited<ReturnType<typeof validate<typeof registerUser.fields, typeof registerUser>>>

    type DataAssertion = Expect<Equal<
      RegisterUserData,
      {
        name: string
        email: string
        age: number | undefined
      } | undefined
    >>
    type SuccessAssertion = Expect<Equal<
      Success,
      FormSubmissionSuccess<{
        name: string
        email: string
        age: number | undefined
      }>
    >>
    type FailureAssertion = Expect<Equal<
      Failure,
      FormSubmissionFailure<{
        name: string
        email: string
        age: number | undefined
      }>
    >>
    type SubmitAssertion = Expect<Equal<SubmitResult, Success | Failure>>

    const success = createSuccessfulSubmission(registerUser, {
      name: 'Ava',
      email: 'ava@example.com',
      age: undefined,
    })
    const failure = createFailedSubmission(registerUser, {
      email: 'broken',
    }, {
      email: ['Email must be valid.'],
    })

    const data: NonNullable<RegisterUserData> = success.data
    const emailErrors = failure.errors.email

    async function expectsTypedSubmission(request: Request) {
      const submission = await validate(request, registerUser, {
        csrf: false,
      })

      if (submission.valid) {
        const typedName: string = submission.data.name
        void typedName
      } else {
        const typedEmailErrors: readonly string[] | undefined = submission.errors.email
        void typedEmailErrors
      }
    }

    async function expectsTypedSecuritySubmission(request: Request) {
      const submission = await validate(request, registerUser, {
        csrf: false,
        throttle: 'login',
      })

      if (submission.valid) {
        const typedEmail: string = submission.data.email
        void typedEmail
      } else {
        const typedEmailErrors: readonly string[] | undefined = submission.errors.email
        void typedEmailErrors
      }
    }

    async function expectsTypedEventSubmission(event: FormRequestLikeInput) {
      const submission = await validate(event, registerUser, {
        csrf: false,
        throttle: 'login',
      })

      if (submission.valid) {
        const typedEmail: string = submission.data.email
        void typedEmail
      } else {
        const typedEmailErrors: readonly string[] | undefined = submission.errors.email
        void typedEmailErrors
      }
    }

    // @ts-expect-error Missing required fields must fail type checking for successful submissions.
    createSuccessfulSubmission(registerUser, {
      email: 'ava@example.com',
      age: undefined,
    })

    void data
    void emailErrors
    void expectsTypedSubmission
    void expectsTypedSecuritySubmission
    void expectsTypedEventSubmission
    void (0 as unknown as RegisterUserErrors)
    void (0 as unknown as DataAssertion)
    void (0 as unknown as SuccessAssertion)
    void (0 as unknown as FailureAssertion)
    void (0 as unknown as SubmitAssertion)
  })
})
