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
    <img v-if="data?.imageUrl" :src="data.imageUrl" alt="" style="width: 100%; border-radius: 1rem; background: #111827;">
    <p>{{ data?.excerpt }}</p>
    <div class="topics">
      <div v-for="tag in data?.tags" :key="tag.id" class="topic">
        <NuxtLink :to="`/tags/${tag.slug}`">#{{ tag.name }}</NuxtLink>
        <small v-if="tag.pivot.is_primary">Primary topic</small>
        <small>Tagged <time :datetime="tag.pivot.created_at">{{ tag.pivot.created_at.slice(0, 10) }}</time></small>
      </div>
    </div>
    <div class="panel">{{ data?.body }}</div>
  </article>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.topics { display: flex; flex-wrap: wrap; gap: 0.75rem; }
.topic { display: grid; gap: 0.25rem; }
.panel { padding: 1.25rem; border-radius: 1rem; background: #111827; line-height: 1.8; }
</style>
