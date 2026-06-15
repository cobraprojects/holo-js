<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { postForm } from '#shared/schemas/blog'

const route = useRoute()
const { data } = await useFetch(`/api/admin/posts/${route.params.id}`, {
  pick: ['post', 'categories', 'tags', 'imageUrl'],
})

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found' })
}

const form = useForm(postForm, {
  validateOn: 'blur',
  initialValues: {
    title: data.value.post.title,
    excerpt: data.value.post.excerpt ?? '',
    body: data.value.post.body,
    status: data.value.post.status === 'published' ? 'published' : 'draft',
    categoryId: data.value.post.category_id ? String(data.value.post.category_id) : '',
    tagIds: data.value.post.tags.map(tag => tag.id),
  },
  async submitter({ formData }) {
    const response = await fetch(`/admin/posts/${data.value?.post.id}/update`, {
      method: 'POST',
      body: formData,
    })

    if (response.ok) {
      await navigateTo('/admin/posts')
      return {
        ok: true,
        status: response.status,
        data: undefined,
      }
    }

    return await response.json()
  },
})
</script>

<template>
  <section class="stack">
    <h1>Edit post</h1>
    <form class="stack" @submit.prevent="form.submit()">
      <input name="title" required v-model="form.values.title" @blur="form.fields.title.onBlur()">
      <p v-if="form.errors.has('title')" class="error">{{ form.errors.first('title') }}</p>
      <textarea name="excerpt" rows="3" v-model="form.values.excerpt"></textarea>
      <textarea name="body" rows="10" required v-model="form.values.body" @blur="form.fields.body.onBlur()"></textarea>
      <img v-if="data?.imageUrl" :src="data.imageUrl" alt="" style="width: 100%; max-width: 28rem; border-radius: 0.75rem;">
      <input name="image" type="file" accept="image/png,image/jpeg,image/webp">
      <p v-if="form.errors.has('image')" class="error">{{ form.errors.first('image') }}</p>
      <select name="categoryId" v-model="form.values.categoryId">
        <option value="">Uncategorized</option>
        <option v-for="category in data?.categories || []" :key="category.id" :value="category.id">{{ category.name }}</option>
      </select>
      <fieldset style="border: 1px solid rgba(148, 163, 184, 0.2); padding: 0.75rem; border-radius: 0.5rem;">
        <legend style="color: #94a3b8; font-size: 0.85rem;">Tags</legend>
        <div style="display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <label v-for="tag in data?.tags || []" :key="tag.id" style="display: flex; gap: 0.25rem; align-items: center;">
            <input type="checkbox" name="tagIds" :value="tag.id" v-model="form.values.tagIds">
            {{ tag.name }}
          </label>
        </div>
      </fieldset>
      <select name="status" v-model="form.values.status"><option value="published">Published</option><option value="draft">Draft</option></select>
      <button type="submit" :disabled="form.submitting">{{ form.submitting ? 'Saving post...' : 'Save post' }}</button>
    </form>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.error { margin: 0; color: #fca5a5; }
</style>
