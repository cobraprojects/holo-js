<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/tags/${route.params.slug}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
}
</script>

<template>
  <section class="stack">
    <h1>#{{ data?.tag.name }}</h1>
    <article v-for="post in data?.posts || []" :key="post.id" class="panel">
      <h2><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h2>
      <p>{{ post.excerpt }}</p>
    </article>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.panel { padding: 1.25rem; border-radius: 1rem; background: #111827; }
</style>
