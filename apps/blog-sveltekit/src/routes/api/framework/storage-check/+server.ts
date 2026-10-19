import { json } from '@sveltejs/kit'
import { checkFrameworkStorage } from '$lib/server/framework-storage'

export async function GET() {
  return json(await checkFrameworkStorage())
}
