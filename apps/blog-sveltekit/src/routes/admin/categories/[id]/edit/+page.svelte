<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>Edit category</h1>
    <form action={`/admin/categories/${data.category.id}/update`} method="post" class="stack">
      <input name="name" value={data.category.name} required>
      <textarea name="description" rows="3">{data.category.description || ''}</textarea>
      <button type="submit">Save category</button>
    </form>
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
</style>
