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

    type ExpectedData = {
      name: string
      email: string
      age: number | undefined
    }

    type RegisterUserData = typeof registerUser.$data
    type RegisterUserErrors = typeof registerUser.$errors
    type ExpectedSubmission = FormSubmissionSuccess<ExpectedData> | FormSubmissionFailure<ExpectedData>

    type DataAssertion = Expect<Equal<
      RegisterUserData,
      ExpectedData | undefined
    >>

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

    type Success = typeof success
    type Failure = typeof failure

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

      return submission
    }

    type SubmitResult = Awaited<ReturnType<typeof expectsTypedSubmission>>
    type SuccessAssertion = Expect<Equal<Success, FormSubmissionSuccess<ExpectedData>>>
    type FailureAssertion = Expect<Equal<Failure, FormSubmissionFailure<ExpectedData>>>
    const fieldKind: string = registerUser.fields.email.definition.kind
    const typedSubmitResult: ExpectedSubmission = null as unknown as SubmitResult
    void fieldKind
    void typedSubmitResult

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

      return submission
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

      return submission
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
  })
})
