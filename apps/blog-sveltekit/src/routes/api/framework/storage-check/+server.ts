import { checkFrameworkStorage } from '#lib/server/framework-storage.js'

export async function GET() {
  return Response.json(await checkFrameworkStorage())
}
