<script setup lang="ts">
const { data } = await useFetch('/api/admin/posts')
</script>

<template>
  <section class="stack">
    <h1>New post</h1>
    <form action="/admin/posts/create" method="post" class="stack">
      <input name="title" placeholder="Title" required>
      <textarea name="excerpt" placeholder="Excerpt" rows="3"></textarea>
      <textarea name="body" placeholder="Body" rows="10" required></textarea>
      <select name="categoryId">
        <option value="">Uncategorized</option>
        <option v-for="category in data?.categories || []" :key="category.id" :value="category.id">{{ category.name }}</option>
      </select>
      <fieldset style="border: 1px solid rgba(148, 163, 184, 0.2); padding: 0.75rem; border-radius: 0.5rem;">
        <legend style="color: #94a3b8; font-size: 0.85rem;">Tags</legend>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <label v-for="tag in data?.tags || []" :key="tag.id" style="display: flex; gap: 0.25rem; align-items: center;">
            <input type="checkbox" name="tagIds" :value="tag.id">
            {{ tag.name }}
          </label>
        </div>
      </fieldset>
      <select name="status"><option value="published">Published</option><option value="draft">Draft</option></select>
      <button type="submit">Create post</button>
    </form>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
</style>
