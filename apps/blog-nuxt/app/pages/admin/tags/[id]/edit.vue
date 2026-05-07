<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/admin/tags/${route.params.id}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
}
</script>

<template>
  <section class="stack">
    <h1>Edit tag</h1>
    <form :action="`/admin/tags/${data?.id}/update`" method="post" class="stack">
      <input name="name" :value="data?.name" required>
      <button type="submit">Save tag</button>
    </form>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
</style>
