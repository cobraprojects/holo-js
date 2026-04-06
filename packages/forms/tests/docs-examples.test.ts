import { describe, expect, it } from 'vitest'
import { field, schema, validate } from '../src'
import { useForm } from '../src/client'

describe('@holo-js/forms documented examples', () => {
  it('covers the documented registration and password reset server flows', async () => {
    const registerUser = schema({
      name: field.string().required().min(3).max(255),
      email: field.string().required().email(),
      password: field.string().required().min(8).confirmed(),
      passwordConfirmation: field.string().required(),
    })

    const registerFailureRequest = new Request('https://example.com/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Ava',
        email: 'bad',
        password: 'supersecret',
        passwordConfirmation: 'mismatch',
      }),
    })

    const registerFailure = await validate(registerFailureRequest, registerUser)
    expect(registerFailure.valid).toBe(false)
    if (!registerFailure.valid) {
      expect(registerFailure.errors.first('email')).toBeDefined()
      expect(registerFailure.errors.first('password')).toBeDefined()
      expect(registerFailure.fail()).toEqual({
        ok: false,
        status: 422,
        valid: false,
        values: registerFailure.values,
        errors: registerFailure.errors.flatten(),
      })
    }

    const registerSuccessRequest = new Request('https://example.com/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Ava',
        email: 'ava@example.com',
        password: 'supersecret',
        passwordConfirmation: 'supersecret',
      }),
    })

    const registerSuccess = await validate(registerSuccessRequest, registerUser)
    expect(registerSuccess.valid).toBe(true)
    if (registerSuccess.valid) {
      expect(registerSuccess.data.email).toBe('ava@example.com')
      expect(registerSuccess.success({
        message: 'Account created.',
      })).toEqual({
        ok: true,
        status: 200,
        data: {
          message: 'Account created.',
        },
      })
    }

    const passwordReset = schema({
      email: field.string().required().email(),
    })

    const passwordResetRequest = new Request('https://example.com/password/forgot', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'ava@example.com',
      }),
    })

    const passwordResetSubmission = await validate(passwordResetRequest, passwordReset)
    expect(passwordResetSubmission.valid).toBe(true)
    if (passwordResetSubmission.valid) {
      expect(passwordResetSubmission.success({
        message: 'Reset link sent.',
      })).toEqual({
        ok: true,
        status: 200,
        data: {
          message: 'Reset link sent.',
        },
      })
    }
  })

  it('covers the documented client login, nested profile, and file upload flows', async () => {
    const loginSchema = schema({
      email: field.string().required().email(),
      password: field.string().required().min(8),
    })

    const login = useForm(loginSchema, {
      initialValues: {
        email: '',
        password: '',
      },
      async submitter() {
        return {
          ok: false as const,
          status: 422,
          valid: false as const,
          values: {
            email: 'bad',
            password: '',
          },
          errors: {
            email: ['Email must be valid.'],
          },
        }
      },
    })

    await login.setValue('email', 'bad')
    await login.setValue('password', 'short')

    const loginResult = await login.submit()
    expect('valid' in loginResult && loginResult.valid === false).toBe(true)
    expect(login.errors.first('email')).toBeDefined()

    const updateProfile = schema({
      displayName: field.string().required().min(3).max(80),
      profile: {
        city: field.string().required(),
        timezone: field.string().required(),
      },
      avatar: field.file().optional().image().maxSize('2mb'),
    })

    const profileForm = useForm(updateProfile, {
      initialValues: {
        displayName: 'Ava',
        profile: {
          city: 'Cairo',
          timezone: 'Africa/Cairo',
        },
        avatar: undefined,
      },
      validateOn: 'blur',
    })

    await profileForm.setValue('profile.city', '')
    await profileForm.fields.profile.city.onBlur()
    expect(profileForm.errors.first('profile.city')).toBe('This field is required.')

    const image = new File([new Uint8Array(128)], 'avatar.png', {
      type: 'image/png',
    })
    await profileForm.setValue('avatar', image)

    const uploadSubmission = await validate(profileForm.values, updateProfile)
    expect(uploadSubmission.valid).toBe(false)
    if (!uploadSubmission.valid) {
      expect(uploadSubmission.errors.first('profile.city')).toBe('This field is required.')
      expect(uploadSubmission.values.avatar).toBe(image)
    }
  })
})
