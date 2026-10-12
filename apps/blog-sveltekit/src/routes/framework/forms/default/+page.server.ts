import { validate } from '@holo-js/forms'
import { contactForm } from '$lib/schemas/framework-forms'
import type { Actions } from './$types'

export const actions = {
  default: async ({ request }) => await validate(request, contactForm),
} satisfies Actions
