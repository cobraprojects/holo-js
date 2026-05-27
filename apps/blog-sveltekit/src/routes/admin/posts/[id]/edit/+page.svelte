<script>
  import { useValidationErrors } from '@holo-js/adapter-sveltekit/client'

  export let data

  const selectedTagIds = new Set(data.post.tags.map(tag => tag.id))
  const errors = useValidationErrors()
</script>

<section class="stack">
  <h1>Edit post</h1>
  <form action="?/update" method="post" enctype="multipart/form-data" class="stack">
    <input {...data.csrf.input}>
    <input name="title" value={data.post.title} required>
    {#if errors.has('title')}<p class="error">{errors.first('title')}</p>{/if}
    <textarea name="excerpt" rows="3">{data.post.excerpt || ''}</textarea>
    {#if errors.has('excerpt')}<p class="error">{errors.first('excerpt')}</p>{/if}
    <textarea name="body" rows="10" required>{data.post.body}</textarea>
    {#if errors.has('body')}<p class="error">{errors.first('body')}</p>{/if}
    {#if data.imageUrl}<img src={data.imageUrl} alt="" style="width: 100%; max-width: 28rem; border-radius: 0.75rem;">{/if}
    <input name="image" type="file" accept="image/png,image/jpeg,image/webp">
    {#if errors.has('image')}<p class="error">{errors.first('image')}</p>{/if}
    <select name="categoryId" value={data.post.category_id || ''}>
      <option value="">Uncategorized</option>
      {#each data.categories as category}<option value={category.id}>{category.name}</option>{/each}
    </select>
    {#if errors.has('categoryId')}<p class="error">{errors.first('categoryId')}</p>{/if}
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
    {#if errors.has('tagIds')}<p class="error">{errors.first('tagIds')}</p>{/if}
    <select name="status" value={data.post.status}><option value="published">Published</option><option value="draft">Draft</option></select>
    {#if errors.has('status')}<p class="error">{errors.first('status')}</p>{/if}
    <button type="submit">Save post</button>
  </form>
</section>

<style>
  .stack { display: grid; gap: 1rem; }
  .error { margin: 0; color: #fca5a5; }
</style>
