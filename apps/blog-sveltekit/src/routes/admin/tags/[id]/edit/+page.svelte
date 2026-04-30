<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>Edit tag</h1>
    <form action={`/admin/tags/${data.tag.id}/update`} method="post" class="stack">
      <input name="name" value={data.tag.name} required>
      <button type="submit">Save tag</button>
    </form>
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
</style>
