<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'

const { authenticated, provider, refreshUser, user } = await useAuth()
const displayName = computed(() => user.value?.name ?? user.value?.email ?? 'Account')
const currentProvider = computed(() => provider.value ?? '')
const isClerkSession = computed(() => currentProvider.value === 'clerk')
const isWorkosSession = computed(() => currentProvider.value === 'workos')

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await refreshUser()
  await navigateTo('/')
}
</script>

<template>
  <div class="shell">
    <header class="header">
      <nav class="nav">
        <NuxtLink to="/" class="brand">blog-nuxt</NuxtLink>
        <NuxtLink to="/posts">Posts</NuxtLink>
        <NuxtLink to="/admin">Admin</NuxtLink>
        <NuxtLink to="/super-admin">Super Admin</NuxtLink>
        <template v-if="authenticated">
          <span class="user-name">{{ displayName }}</span>
          <button type="button" class="logout-button" @click="logout">Logout</button>
          <form v-if="isWorkosSession" action="/api/auth/workos/logout" method="post" class="logout-form">
            <button type="submit" class="logout-button">Logout from WorkOS</button>
          </form>
          <form v-if="isClerkSession" action="/api/auth/clerk/logout" method="post" class="logout-form">
            <button type="submit" class="logout-button">Logout from Clerk</button>
          </form>
        </template>
        <template v-else>
          <NuxtLink to="/login">Login</NuxtLink>
          <NuxtLink to="/register">Register</NuxtLink>
        </template>
      </nav>
    </header>
    <main class="content">
      <NuxtPage />
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  background: #0b1020;
  color: #e5eef8;
  font-family: Inter, Arial, sans-serif;
}
.header {
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}
.nav,
.content {
  max-width: 72rem;
  margin: 0 auto;
  padding: 1rem 1.5rem;
}
.nav {
  display: flex;
  gap: 1rem;
  align-items: center;
  flex-wrap: wrap;
}
.brand {
  font-weight: 700;
}
.user-name {
  color: #e5eef8;
}
.logout-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font: inherit;
}
.logout-form {
  display: inline;
}
a {
  color: #cbd5e1;
  text-decoration: none;
}
</style>
