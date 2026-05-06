<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { untrack } from 'svelte'
  import { useAuth } from '@holo-js/adapter-sveltekit/client'
  import type { LayoutProps } from './$types'

  let { data, children }: LayoutProps = $props()

  const auth = useAuth({ initialUser: untrack(() => data.auth.user) })
  const displayName = $derived(auth.user?.name ?? auth.user?.email ?? 'Account')

  async function logout() {
    const response = await fetch('/api/logout', { method: 'POST' })
    if (!response.ok) {
      return
    }

    await auth.refreshUser()
    await invalidateAll()
  }
</script>

<div class="shell">
  <header class="header">
    <nav class="nav">
      <a href="/" class="brand">blog-sveltekit</a>
      <a href="/posts">Posts</a>
      <a href="/admin">Admin</a>
      {#if auth.authenticated}
        <span class="user-name">{displayName}</span>
        <button type="button" class="logout-button" onclick={logout}>Logout</button>
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
  a {
    color: #cbd5e1;
    text-decoration: none;
  }
</style>
