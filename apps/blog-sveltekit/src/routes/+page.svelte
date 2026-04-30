<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<svelte:head><title>blog-sveltekit</title></svelte:head>

<section class="stack">
  <div class="hero">
    <h1>Ship a real Holo blog on SvelteKit</h1>
    <p>This app demonstrates the first real blog slice using public Holo APIs only.</p>
  </div>

  {#if data.featured}
    <article class="panel">
      <h2><a href={`/posts/${data.featured.slug}`}>{data.featured.title}</a></h2>
      <p>{data.featured.excerpt}</p>
    </article>
  {/if}

  {#each data.posts as post}
    <article class="panel">
      <h3><a href={`/posts/${post.slug}`}>{post.title}</a></h3>
      <p>{post.excerpt}</p>
      <div class="meta">
        {#if post.category}
          <a href={`/categories/${post.category.slug}`} class="category-link">{post.category.name}</a>
        {/if}
        {#each post.tags as tag}
          <a href={`/tags/${tag.slug}`} class="tag-link">#{tag.name}</a>
        {/each}
      </div>
    </article>
  {/each}

  <div class="grid">
    <section class="panel">
      <h3>Categories</h3>
      <ul class="list">
        {#each data.categories as category}
          <li><a href={`/categories/${category.slug}`}>{category.name}</a></li>
        {/each}
      </ul>
    </section>

    <section class="panel">
      <h3>Tags</h3>
      <div class="meta">
        {#each data.tags as tag}
          <a href={`/tags/${tag.slug}`} class="tag-link">#{tag.name}</a>
        {/each}
      </div>
    </section>
  </div>
</section>

<style>
  .stack {
    display: grid;
    gap: 1rem;
  }
  .grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  }
  .hero,
  .panel {
    padding: 1.25rem;
    border-radius: 1rem;
    background: #111827;
  }
  .meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .category-link {
    color: #7dd3fc;
  }
  .tag-link {
    color: #f9a8d4;
  }
  .list {
    margin: 0;
    padding-left: 1rem;
  }
  h1,
  h2,
  h3 {
    margin-top: 0;
  }
  p {
    color: #cbd5e1;
  }
</style>
