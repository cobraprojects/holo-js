import { field, schema } from '@holo-js/forms/schema'

export const loginForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.'),
  remember: field.boolean().default(false),
})

export const registerForm = schema({
  name: field.string().required('Name is required.').min(3, 'Name must be at least 3 characters.'),
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.').confirmed(),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})

export const forgotPasswordForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
})

export const resendEmailVerificationForm = schema({
  email: field.string().required('Email is required.').email('Enter a valid email address.'),
})

export const resetPasswordForm = schema({
  token: field.string().required('Reset token is required.'),
  password: field.password().required('Password is required.').min(8, 'Password must be at least 8 characters.').confirmed(),
  passwordConfirmation: field.password().required('Please confirm your password.'),
})

export const verifyEmailForm = schema({
  token: field.string().required('Verification token is required.'),
})
