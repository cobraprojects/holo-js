'use server'

import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'

const profileForm = schema({
  email: field.string().required().email('Email rejected for profile.'),
  password: field.password(),
})

export async function saveProfile(formData: FormData) {
  await validate(formData, profileForm, { bag: 'profile' })
}
