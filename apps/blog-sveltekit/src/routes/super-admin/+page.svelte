<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()
  let isLoggingOut = $state(false)
  const displayName = $derived(data.admin?.name ?? data.admin?.email ?? 'Super Admin')

  async function logout() {
    if (isLoggingOut) {
      return
    }

    isLoggingOut = true
    try {
      const response = await fetch('/api/super-admin/logout', { method: 'POST' })
      if (!response.ok) {
        console.warn('Super admin logout failed.', { status: response.status })
        return
      }

      await invalidateAll()
      await goto('/super-admin/login')
    } catch (error) {
      console.warn('Super admin logout failed.', error)
    } finally {
      isLoggingOut = false
    }
  }
</script>

<section class="stack">
  <p class="eyebrow">Admin guard</p>
  <h1>Super Admin</h1>
  <p>Signed in as {displayName} through the admin guard.</p>
  <div>
    <button type="button" disabled={isLoggingOut} onclick={logout}>
      {isLoggingOut ? 'Signing out...' : 'Sign out of super admin'}
    </button>
  </div>
</section>

<style>
  .stack {
    display: grid;
    gap: 0.75rem;
    max-width: 42rem;
  }
  .eyebrow {
    margin: 0;
    color: #7dd3fc;
    font-size: 0.875rem;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
  }
  p {
    margin: 0;
    color: #cbd5e1;
  }
</style>
