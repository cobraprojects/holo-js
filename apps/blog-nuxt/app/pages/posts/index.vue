<script setup lang="ts">
import type { PublishedPostsData } from '../../../server/lib/blog'

const { data } = await useFetch<PublishedPostsData>('/api/blog/posts')
</script>

<template>
  <section class="stack">
    <h1>Posts</h1>
    <article v-for="post in data || []" :key="post.id" class="panel">
      <h2><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h2>
      <p>{{ post.excerpt }}</p>
    </article>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.panel { padding: 1.25rem; border-radius: 1rem; background: #111827; }
</style>
