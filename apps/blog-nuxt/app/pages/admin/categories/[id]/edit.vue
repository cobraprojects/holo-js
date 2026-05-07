<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/admin/categories/${route.params.id}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Category not found' })
}
</script>

<template>
  <section class="stack">
    <h1>Edit category</h1>
    <form :action="`/admin/categories/${data?.id}/update`" method="post" class="stack">
      <input name="name" :value="data?.name" required>
      <textarea name="description" rows="3">{{ data?.description }}</textarea>
      <button type="submit">Save category</button>
    </form>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
</style>
