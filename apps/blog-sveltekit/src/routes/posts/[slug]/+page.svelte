<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

{#if data}
  <article class="stack">
    <a href="/posts">Back to posts</a>
    <h1>{data.post.title}</h1>
    {#if data.imageUrl}<img src={data.imageUrl} alt="" style="width: 100%; border-radius: 1rem; background: #111827;">{/if}
    <p>{data.post.excerpt}</p>
    <div class="topics">
      {#each data.post.tags as tag (tag.id)}
        <div class="topic">
          <a href={`/tags/${tag.slug}`}>#{tag.name}</a>
          {#if tag.pivot.is_primary}<small>Primary topic</small>{/if}
          <small>Tagged <time datetime={tag.pivot.created_at.toISOString()}>{tag.pivot.created_at.toISOString().slice(0, 10)}</time></small>
        </div>
      {/each}
    </div>
    <div class="panel">{data.post.body}</div>
  </article>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .topics { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .topic { display: grid; gap: 0.25rem; }
  .panel { padding: 1.25rem; border-radius: 1rem; background: #111827; line-height: 1.8; }
</style>
