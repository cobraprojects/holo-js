import type { CurrentAuthResponse, HoloAuthUser } from './contracts'
import { computed, useFetch, useState } from '#imports'

export type { HoloAuthUser } from './contracts'

export type UseAuthOptions = {
  readonly endpoint?: string
  readonly guard?: string
  readonly key?: string
}

export type UseAuthResult = {
  readonly authenticated: Readonly<{ readonly value: boolean }>
  readonly user: { value: HoloAuthUser | null }
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

function createCurrentAuthUrl(endpoint: string, guard: string | undefined): string {
  if (!guard) {
    return endpoint
  }

  const base = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? new URL(endpoint)
    : new URL(endpoint, 'https://holo.local')
  base.searchParams.set('guard', guard)

  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return base.toString()
  }

  return `${base.pathname}${base.search}${base.hash}`
}

function useCurrentAuthFetch(requestUrl: string, stateKey: string) {
  return useFetch<CurrentAuthResponse>(requestUrl, {
    key: `${stateKey}:request`,
  })
}

export async function useAuth(options: UseAuthOptions = {}): Promise<UseAuthResult> {
  const endpoint = options.endpoint ?? '/api/auth/user'
  const requestUrl = createCurrentAuthUrl(endpoint, options.guard)
  const stateKey = options.key ?? `holo-auth:${requestUrl}`
  const currentUser = useState<HoloAuthUser | null>(`${stateKey}:user`, () => null)
  const authenticated = computed(() => currentUser.value !== null)
  const { data, refresh } = await useCurrentAuthFetch(requestUrl, stateKey)

  currentUser.value = data.value?.user ?? null

  return {
    authenticated,
    user: currentUser,
    async refreshUser() {
      await refresh()
      currentUser.value = data.value?.user ?? null

      return currentUser.value
    },
  }
}
