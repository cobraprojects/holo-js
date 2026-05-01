<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>New post</h1>
    <form action="/admin/posts/create" method="post" class="stack">
      <input name="title" placeholder="Title" required>
      <textarea name="excerpt" placeholder="Excerpt" rows="3"></textarea>
      <textarea name="body" placeholder="Body" rows="10" required></textarea>
      <select name="categoryId">
        <option value="">Uncategorized</option>
        {#each data.categories as category}<option value={category.id}>{category.name}</option>{/each}
      </select>
      <fieldset style="border: 1px solid rgba(148, 163, 184, 0.2); padding: 0.75rem; border-radius: 0.5rem;">
        <legend style="color: #94a3b8; font-size: 0.85rem;">Tags</legend>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          {#each data.tags as tag}
            <label style="display: flex; gap: 0.25rem; align-items: center;">
              <input type="checkbox" name="tagIds" value={tag.id}>
              {tag.name}
            </label>
          {/each}
        </div>
      </fieldset>
      <select name="status"><option value="published">Published</option><option value="draft">Draft</option></select>
      <button type="submit">Create post</button>
    </form>
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
</style>
