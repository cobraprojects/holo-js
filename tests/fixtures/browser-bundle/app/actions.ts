'use server'

import { redirect } from 'next/navigation'

export async function submitQuote(name: string) {
  if (name === 'redirect') redirect('/done')
  return { ok: true, status: 200, data: { name } }
}
