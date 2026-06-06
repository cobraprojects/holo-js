<script lang="ts">
  import { useFlux } from '@holo-js/flux-svelte'
  import { type PageData } from './$types'

  export let data: PageData
  let latestPostChange = 'Waiting for post activity'

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    latestPostChange = `${payload.action}: ${payload.title}`
  })
</script>

{#if data}
  <section class="stack">
    <h1>Admin</h1>
    <div class="grid">
      <article class="panel"><strong>{data.postCount}</strong><div>Posts</div></article>
      <article class="panel"><strong>{data.publishedCount}</strong><div>Published</div></article>
      <article class="panel"><strong>{data.categoryCount}</strong><div>Categories</div></article>
      <article class="panel"><strong>{data.tagCount}</strong><div>Tags</div></article>
    </div>
    <article class="panel live-panel">
      <strong>Live post activity</strong>
      <div data-testid="broadcast-post-activity">{latestPostChange}</div>
    </article>
    <div class="links">
      <a href="/admin/posts">Manage posts</a>
      <a href="/admin/categories">Manage categories</a>
      <a href="/admin/tags">Manage tags</a>
    </div>
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; }
  .panel { padding: 1rem; border-radius: 1rem; background: #111827; }
  .live-panel { border: 1px solid rgba(125, 211, 252, 0.3); }
  .links { display: flex; gap: 1rem; flex-wrap: wrap; }
  .links a { color: #7dd3fc; }
</style>
