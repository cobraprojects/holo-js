import { validate } from '@holo-js/forms'
import { field, schema } from '@holo-js/validation'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => await validate(request, schema({
    email: field.string().required().email('Email rejected for profile.'),
  }), { bag: 'profile' }),
} satisfies Actions
