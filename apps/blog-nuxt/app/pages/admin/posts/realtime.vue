<script setup lang="ts">
import { computed, ref } from 'vue'
import { adminPosts, renameAdminPost } from '../../../../server/realtime/posts'

const data = adminPosts()
const selectedPostId = ref<number | null>(null)
const title = ref('')
const saving = ref(false)
const posts = computed(() => data.posts ?? [])

function selectPost(post: typeof posts.value[number]) {
  selectedPostId.value = post.id
  title.value = `${post.title} updated`
}

async function savePost() {
  if (!selectedPostId.value) {
    return
  }

  saving.value = true
  try {
    await renameAdminPost({ id: selectedPostId.value, title: title.value })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="stack">
    <div class="row"><h1>Realtime posts</h1><NuxtLink to="/admin/posts">Posts</NuxtLink></div>
    <form class="editor" @submit.prevent="savePost">
      <input v-model="title" aria-label="Realtime post title">
      <button type="submit" :disabled="!selectedPostId || saving">Save realtime title</button>
    </form>
    <article v-for="post in posts" :key="post.id" class="panel row" :data-post-id="post.id">
      <div>
        <h2>{{ post.title }}</h2>
        <p>{{ post.status }} · {{ post.category?.name || 'Uncategorized' }} · {{ post.tags.map(tag => tag.name).join(', ') || 'No tags' }}</p>
      </div>
      <button type="button" @click="selectPost(post)">Edit title</button>
    </article>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
.editor { display: flex; gap: 0.75rem; flex-wrap: wrap; }
.editor input { min-width: 18rem; flex: 1 1 18rem; }
.panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
