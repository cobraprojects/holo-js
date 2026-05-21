<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { untrack } from 'svelte'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import type { LayoutProps } from './$types'

  let { data, children }: LayoutProps = $props()
  let isLoggingOut = $state(false)

  const auth = useAuth({
    initialProvider: untrack(() => data?.auth?.provider ?? null),
    initialUser: untrack(() => data?.auth?.user ?? null),
  })
  const displayName = $derived(auth.user?.name ?? auth.user?.email ?? 'Account')
  const usesHostedLogout = $derived(auth.provider === 'workos' || auth.provider === 'clerk')

  async function logout() {
    if (isLoggingOut) {
      return
    }

    isLoggingOut = true
    try {
      const response = await fetch('/api/logout', { method: 'POST' })
      if (!response.ok) {
        console.warn('Logout failed.', { status: response.status })
        return
      }

      try {
        await auth.refreshUser()
      } catch (error) {
        console.warn('Auth refresh failed after logout.', error)
      }

      try {
        await invalidateAll()
      } catch (error) {
        console.warn('Auth invalidation failed after logout.', error)
      }
    } catch (error) {
      console.warn('Logout failed.', error)
    } finally {
      isLoggingOut = false
    }
  }
</script>

<div class="shell">
  <header class="header">
    <nav class="nav">
      <a href="/" class="brand">blog-sveltekit</a>
      <a href="/posts">Posts</a>
      <a href="/api-token-posts">API Token</a>
      <a href="/admin">Admin</a>
      <a href="/super-admin">Super Admin</a>
      {#if auth.authenticated}
        <span class="user-name">{displayName}</span>
        {#if !usesHostedLogout}
          <button type="button" class="logout-button" disabled={isLoggingOut} aria-busy={isLoggingOut} onclick={logout}>Logout</button>
        {/if}
        {#if auth.provider === 'workos'}
          <form action="/api/auth/workos/logout" method="post" class="logout-form">
            <button type="submit" class="logout-button">Logout from WorkOS</button>
          </form>
        {/if}
        {#if auth.provider === 'clerk'}
          <form action="/api/auth/clerk/logout" method="post" class="logout-form">
            <button type="submit" class="logout-button">Logout from Clerk</button>
          </form>
        {/if}
      {:else}
        <a href="/login">Login</a>
        <a href="/register">Register</a>
      {/if}
    </nav>
  </header>
  <main class="content">
    {@render children()}
  </main>
</div>

<style>
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
  .logout-button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
    pointer-events: none;
  }
  .logout-form {
    display: inline;
  }
  a {
    color: #cbd5e1;
    text-decoration: none;
  }
</style>
