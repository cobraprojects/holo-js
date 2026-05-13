import auth, { check, provider, user } from '@holo-js/auth'

export async function GET(request: Request) {
  const guard = new URL(request.url).searchParams.get('guard') ?? undefined
  const guardAuth = guard ? auth.guard(guard) : undefined

  return Response.json({
    authenticated: guardAuth ? await guardAuth.check() : await check(),
    guard: guard ?? 'web',
    provider: guardAuth ? await guardAuth.provider() : await provider(),
    user: guardAuth ? await guardAuth.user() : await user(),
  })
}
