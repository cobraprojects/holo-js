<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>Categories</h1>
    <form action="/admin/categories/create" method="post" class="stack">
      <input name="name" placeholder="Category name" required>
      <textarea name="description" rows="3" placeholder="Description"></textarea>
      <button type="submit">Create category</button>
    </form>
    {#each data.categories as category}
      <article class="panel row">
        <div><strong>{category.name}</strong><div>{category.slug}</div></div>
        <div class="row">
          <a href={`/admin/categories/${category.id}/edit`}>Edit</a>
          <form action={`/admin/categories/${category.id}/delete`} method="post"><button type="submit">Delete</button></form>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
  .panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
