import type { SecurityCsrfSessionAccessor } from '@holo-js/security'
import type { SessionRecord, SessionRuntimeFacade } from '@holo-js/session'

const CSRF_SESSION_KEY = '_token'

type CsrfSessionModule = {
  getSessionRuntime(): SessionRuntimeFacade
  parseCookieHeader(header: string | null | undefined): Readonly<Record<string, string>>
}

export function createCsrfSessionAccessor(
  sessionModule: CsrfSessionModule,
  cookieName: () => string,
): SecurityCsrfSessionAccessor {
  async function resolveRecord(request: Request): Promise<SessionRecord | null> {
    const session = sessionModule.getSessionRuntime()
    const cookies = sessionModule.parseCookieHeader(request.headers.get('cookie'))
    const name = cookieName()
    const sessionCookie = cookies[name]
    const sessionId = sessionCookie ? session.decryptCookie(name, sessionCookie) : undefined
    return sessionId ? await session.read(sessionId) : null
  }

  return Object.freeze({
    async read(request: Request) {
      const token = (await resolveRecord(request))?.data[CSRF_SESSION_KEY]
      return typeof token === 'string' && token ? token : undefined
    },
    async write(request: Request, token: string) {
      const session = sessionModule.getSessionRuntime()
      const record = await resolveRecord(request)
      if (record) {
        const stored = await session.setDataIfAbsent(record.id, CSRF_SESSION_KEY, token, { store: record.store })
        if (stored.found) {
          if (typeof stored.value !== 'string' || !stored.value) {
            throw new Error('[@holo-js/core] Session store did not persist a valid CSRF token.')
          }
          return { token: stored.value, cookies: [] }
        }
      }

      const created = await session.create({ data: { [CSRF_SESSION_KEY]: token } })
      return { token, cookies: [session.sessionCookie(created.id)] }
    },
  })
}
