import { json } from '@sveltejs/kit'
import auth, { check, isAuthError, provider, user } from '@holo-js/auth'

export async function GET({ url }: { url: URL }) {
  const guard = url.searchParams.get('guard') ?? undefined
  try {
    const guardAuth = guard ? auth.guard(guard) : undefined

    return json({
      authenticated: guardAuth ? await guardAuth.check() : await check(),
      guard: guard ?? 'web',
      provider: guardAuth ? await guardAuth.provider() : await provider(),
      user: guardAuth ? await guardAuth.user() : await user(),
    })
  } catch (error) {
    if (isAuthError(error) && error.code === 'guard_not_configured') {
      return json({
        authenticated: false,
        guard: guard ?? 'web',
        provider: null,
        user: null,
      }, { status: 400 })
    }

    throw error
  }
}
