'use server'

import { redirect } from 'next/navigation'
import { field, schema, validate } from '@holo-js/validation'

const nameForm = schema({ name: field.string().required('Name is required') })

export async function submitQuote(name: string) {
  if (name === 'redirect') redirect('/done')
  return { ok: true, status: 200, data: { name } }
}

export async function saveName(formData: FormData) {
  await validate({ name: String(formData.get('name') ?? '') }, nameForm)
}
