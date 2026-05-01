<script setup lang="ts">
const { data } = await useFetch('/api/admin/tags')
</script>

<template>
  <section class="stack">
    <h1>Tags</h1>
    <form action="/admin/tags/create" method="post" class="stack">
      <input name="name" placeholder="Tag name" required>
      <button type="submit">Create tag</button>
    </form>
    <article v-for="tag in data?.tags || []" :key="tag.id" class="panel row">
      <div><strong>{{ tag.name }}</strong><div>{{ tag.slug }}</div></div>
      <div class="row">
        <NuxtLink :to="`/admin/tags/${tag.id}/edit`">Edit</NuxtLink>
        <form :action="`/admin/tags/${tag.id}/delete`" method="post"><button type="submit">Delete</button></form>
      </div>
    </article>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
.panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
