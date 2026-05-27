<script setup lang="ts">
const { data } = await useFetch('/api/admin/posts')
</script>

<template>
  <section class="stack">
    <div class="row"><h1>Posts</h1><NuxtLink to="/admin/posts/new">New post</NuxtLink></div>
    <article v-for="post in data?.posts || []" :key="post.id" class="panel row">
      <div>
        <h2>{{ post.title }}</h2>
        <p>{{ post.status }} · {{ post.category?.name || 'Uncategorized' }}</p>
      </div>
      <div class="row">
        <NuxtLink :to="`/admin/posts/${post.id}/edit`">Edit</NuxtLink>
        <form :action="`/admin/posts/${post.id}/delete`" method="post"><button type="submit">Delete</button></form>
      </div>
    </article>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
.panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
