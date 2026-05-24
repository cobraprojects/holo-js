<script lang="ts">
  import type { PageProps } from './$types'

  let { data }: PageProps = $props()
  const displayName = $derived(data.admin?.name ?? data.admin?.email ?? 'Super Admin')
</script>

<section class="stack">
  <p class="eyebrow">Admin guard</p>
  <h1>Super Admin</h1>
  <p>Signed in as {displayName} through the admin guard.</p>
  <div>
    <form method="post">
      <button type="submit">Sign out of super admin</button>
    </form>
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
