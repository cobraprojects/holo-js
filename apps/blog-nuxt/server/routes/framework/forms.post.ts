import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
import { setCookie } from 'h3'

export default defineEventHandler(async event => {
  setCookie(event, 'holo_native_form', 'retained', { httpOnly: true, sameSite: 'lax' })
  return await validate(event, schema({
    email: field.string().required().email('Email rejected for profile.'),
  }), { bag: 'profile' })
})
