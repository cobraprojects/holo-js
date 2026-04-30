<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>Tags</h1>
    <form action="/admin/tags/create" method="post" class="stack">
      <input name="name" placeholder="Tag name" required>
      <button type="submit">Create tag</button>
    </form>
    {#each data.tags as tag}
      <article class="panel row">
        <div><strong>{tag.name}</strong><div>{tag.slug}</div></div>
        <div class="row">
          <a href={`/admin/tags/${tag.id}/edit`}>Edit</a>
          <form action={`/admin/tags/${tag.id}/delete`} method="post"><button type="submit">Delete</button></form>
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
