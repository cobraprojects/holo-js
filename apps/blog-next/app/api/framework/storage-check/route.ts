import { checkFrameworkStorage } from '../../../../server/lib/framework-storage'

export async function GET() {
  return Response.json(await checkFrameworkStorage())
}
