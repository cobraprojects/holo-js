<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <section class="stack">
    <h1>{data.category.name}</h1>
    <p>{data.category.description}</p>
    {#each data.posts as post}
      <article class="panel">
        <h2><a href={`/posts/${post.slug}`}>{post.title}</a></h2>
        <p>{post.excerpt}</p>
      </article>
    {/each}
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .panel { padding: 1.25rem; border-radius: 1rem; background: #111827; }
</style>
