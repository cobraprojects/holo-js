<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/posts/${route.params.slug}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found' })
}
</script>

<template>
  <article class="stack">
    <NuxtLink to="/posts">Back to posts</NuxtLink>
    <h1>{{ data?.title }}</h1>
    <p>{{ data?.excerpt }}</p>
    <div class="panel">{{ data?.body }}</div>
  </article>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.panel { padding: 1.25rem; border-radius: 1rem; background: #111827; line-height: 1.8; }
</style>
