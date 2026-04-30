<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData

  const selectedTagIds = new Set(data.post.tags.map(tag => tag.id))
</script>

<section class="stack">
  <h1>Edit post</h1>
  <form action={`/admin/posts/${data.post.id}/update`} method="post" class="stack">
    <input name="title" value={data.post.title} required>
    <textarea name="excerpt" rows="3">{data.post.excerpt || ''}</textarea>
    <textarea name="body" rows="10" required>{data.post.body}</textarea>
    <select name="categoryId" value={data.post.category_id || ''}>
      <option value="">Uncategorized</option>
      {#each data.categories as category}<option value={category.id}>{category.name}</option>{/each}
    </select>
    <fieldset style="border: 1px solid rgba(148, 163, 184, 0.2); padding: 0.75rem; border-radius: 0.5rem;">
      <legend style="color: #94a3b8; font-size: 0.85rem;">Tags</legend>
      <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
        {#each data.tags as tag}
          <label style="display: flex; gap: 0.25rem; align-items: center;">
            <input type="checkbox" name="tagIds" value={tag.id} checked={selectedTagIds.has(tag.id)}>
            {tag.name}
          </label>
        {/each}
      </div>
    </fieldset>
    <select name="status" value={data.post.status}><option value="published">Published</option><option value="draft">Draft</option></select>
    <button type="submit">Save post</button>
  </form>
</section>

<style>
  .stack { display: grid; gap: 1rem; }
</style>
