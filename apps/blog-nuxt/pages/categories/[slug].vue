<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/categories/${route.params.slug}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Category not found' })
}
</script>

<template>
  <section class="stack">
    <h1>{{ data?.category.name }}</h1>
    <p>{{ data?.category.description }}</p>
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
