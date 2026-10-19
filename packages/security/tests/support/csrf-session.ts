import type { SecurityCsrfSessionAccessor } from '../../src'

export type MemoryCsrfSessions = SecurityCsrfSessionAccessor & {
  readonly tokens: Map<string, string>
  readonly writes: string[]
}

export const TEST_SESSION_COOKIE = 'browser'

function sessionIdOf(request: Request): string | undefined {
  return new RegExp(`(?:^|;\\s*)${TEST_SESSION_COOKIE}=([^;]+)`).exec(request.headers.get('cookie') ?? '')?.[1]
}

export function memoryCsrfSessions(initial: Readonly<Record<string, string>> = {}): MemoryCsrfSessions {
  const tokens = new Map<string, string>(Object.entries(initial))
  const writes: string[] = []
  let created = 0
  return {
    tokens,
    writes,
    async read(request) {
      const id = sessionIdOf(request)
      return id ? tokens.get(id) : undefined
    },
    async write(request, token) {
      const existing = sessionIdOf(request)
      const id = existing && tokens.has(existing) ? existing : `guest-${++created}`
      tokens.set(id, token)
      writes.push(id)
      return id === existing ? [] : [`${TEST_SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`]
    },
  }
}
