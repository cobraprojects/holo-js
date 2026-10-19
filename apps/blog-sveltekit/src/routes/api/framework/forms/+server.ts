import { json } from '@sveltejs/kit'
import { validate } from '@holo-js/forms'
import { csrf } from '@holo-js/security'
import { field, schema } from '@holo-js/validation'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ request }) => {
  const { name: field, value: token } = await csrf.field(request)
  return json({ token, field })
}

export const POST: RequestHandler = async ({ request }) => json({
  ok: true,
  status: 201,
  data: await validate(request, schema({ email: field.string().required().email() })),
}, { status: 201 })
