<script setup lang="ts">
const { data } = await useFetch('/api/blog/home')
</script>

<template>
  <section class="stack">
    <div class="hero">
      <h1>Ship a real Holo blog on Nuxt</h1>
      <p>This app demonstrates the first real blog slice using public Holo APIs only.</p>
    </div>

    <article v-if="data?.featured" class="panel">
      <h2><NuxtLink :to="`/posts/${data.featured.slug}`">{{ data.featured.title }}</NuxtLink></h2>
      <p>{{ data.featured.excerpt }}</p>
    </article>

    <article v-for="post in data?.posts || []" :key="post.id" class="panel">
      <h3><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h3>
      <p>{{ post.excerpt }}</p>
      <div class="meta">
        <NuxtLink v-if="post.category" :to="`/categories/${post.category.slug}`" class="category-link">
          {{ post.category.name }}
        </NuxtLink>
        <NuxtLink v-for="tag in post.tags" :key="tag.id" :to="`/tags/${tag.slug}`" class="tag-link">
          #{{ tag.name }}
        </NuxtLink>
      </div>
    </article>

    <div class="grid">
      <section class="panel">
        <h3>Categories</h3>
        <ul class="list">
          <li v-for="category in data?.categories || []" :key="category.id">
            <NuxtLink :to="`/categories/${category.slug}`">{{ category.name }}</NuxtLink>
          </li>
        </ul>
      </section>

      <section class="panel">
        <h3>Tags</h3>
        <div class="meta">
          <NuxtLink v-for="tag in data?.tags || []" :key="tag.id" :to="`/tags/${tag.slug}`" class="tag-link">
            #{{ tag.name }}
          </NuxtLink>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.stack { display: grid; gap: 1rem; }
.hero, .panel { padding: 1.25rem; border-radius: 1rem; background: #111827; }
.grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.meta { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.category-link { color: #7dd3fc; }
.tag-link { color: #f9a8d4; }
.list { margin: 0; padding-left: 1rem; }
h1, h2, h3 { margin-top: 0; }
p { color: #cbd5e1; }
</style>
