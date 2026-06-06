<script setup lang="ts">
import { useFlux } from '@holo-js/flux-vue'

const { data } = await useFetch('/api/admin/dashboard')
const latestPostChange = ref('Waiting for post activity')

useFlux('blog.admin', 'blog.post.changed', (payload) => {
  latestPostChange.value = `${payload.action}: ${payload.title}`
})
</script>

<template>
  <section class="stack">
    <h1>Admin</h1>
    <div class="grid">
      <article class="panel"><strong>{{ data?.postCount }}</strong><div>Posts</div></article>
      <article class="panel"><strong>{{ data?.publishedCount }}</strong><div>Published</div></article>
      <article class="panel"><strong>{{ data?.categoryCount }}</strong><div>Categories</div></article>
      <article class="panel"><strong>{{ data?.tagCount }}</strong><div>Tags</div></article>
    </div>
    <article class="panel live-panel">
      <strong>Live post activity</strong>
      <div data-testid="broadcast-post-activity">{{ latestPostChange }}</div>
    </article>
    <div class="links">
      <NuxtLink to="/admin/posts">Manage posts</NuxtLink>
      <NuxtLink to="/admin/categories">Manage categories</NuxtLink>
      <NuxtLink to="/admin/tags">Manage tags</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; }
.panel { padding: 1rem; border-radius: 1rem; background: #111827; }
.live-panel { border: 1px solid rgba(125, 211, 252, 0.3); }
.links { display: flex; gap: 1rem; flex-wrap: wrap; }
.links a { color: #7dd3fc; }
</style>
