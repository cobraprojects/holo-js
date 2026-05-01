<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <article class="stack">
    <a href="/posts">Back to posts</a>
    <h1>{data.post.title}</h1>
    <p>{data.post.excerpt}</p>
    <div class="panel">{data.post.body}</div>
  </article>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .panel { padding: 1.25rem; border-radius: 1rem; background: #111827; line-height: 1.8; }
</style>
