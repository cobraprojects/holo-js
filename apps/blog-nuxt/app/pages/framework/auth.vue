<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { authOnly, guestOnly } from '@holo-js/auth/nuxt/server'

definePageMeta({
  middleware: async (to, from) => {
    const mode = String(to.query.mode ?? '')
    const guard = to.query.guard === 'admin' ? 'admin' : undefined
    const redirectTo = mode.endsWith('self') ? '/framework/auth?from=guard#state' : mode.startsWith('guest') ? guard === 'admin' ? '/super-admin' : '/admin' : guard === 'admin' ? '/super-admin/login' : '/login'
    const routes = mode.endsWith('regex') ? [/^\/framework\/auth$/g]
      : mode.endsWith('function') ? [(path: string) => path === '/framework/auth']
        : mode.endsWith('unmatched') ? ['/unrelated/*'] : ['/framework/*']
    const options = { guard, redirectTo, routes, status: 302 as const }
    if (mode.startsWith('guest')) return await guestOnly(options)(to, from)
    if (mode.startsWith('auth')) return await authOnly(options)(to, from)
  },
})

const route = useRoute()
const current = await useAuth({
  guard: typeof route.query.guard === 'string' ? route.query.guard : undefined,
  endpoint: route.query.absolute === '1'
    ? `${useRequestURL().origin}/api/auth/user?from=framework#state`
    : '/api/auth/user?from=framework#state',
})
</script>

<template>
  <main>
    <h1>Framework authentication</h1>
    <output data-testid="authenticated">{{ current.authenticated.value }}</output>
    <output data-testid="provider">{{ current.provider.value ?? 'none' }}</output>
    <output data-testid="user">{{ current.user.value?.email ?? 'none' }}</output>
    <button type="button" @click="current.refreshUser()">Refresh authentication</button>
  </main>
</template>
