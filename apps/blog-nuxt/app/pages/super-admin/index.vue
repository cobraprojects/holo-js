<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

definePageMeta({
  middleware: 'super-admin',
})

const { refreshUser, user } = await useAuth({ guard: 'admin' })
const displayName = computed(() => user.value?.name ?? user.value?.email ?? 'Super Admin')
const isLoggingOut = ref(false)

async function logout() {
  if (isLoggingOut.value) {
    return
  }

  isLoggingOut.value = true
  try {
    await $fetch('/api/super-admin/logout', { method: 'POST' })
    await refreshUser()
    await navigateTo('/super-admin/login')
  } catch (error) {
    console.warn('Super admin logout failed.', error)
  } finally {
    isLoggingOut.value = false
  }
}
</script>

<template>
  <section class="stack">
    <p class="eyebrow">Admin guard</p>
    <h1>Super Admin</h1>
    <p>Signed in as {{ displayName }} through the admin guard.</p>
    <div>
      <button type="button" :disabled="isLoggingOut" @click="logout">
        {{ isLoggingOut ? 'Signing out...' : 'Sign out of super admin' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 0.75rem; max-width: 42rem; }
.eyebrow { margin: 0; color: #7dd3fc; font-size: 0.875rem; text-transform: uppercase; }
h1 { margin: 0; }
p { margin: 0; color: #cbd5e1; }
</style>
