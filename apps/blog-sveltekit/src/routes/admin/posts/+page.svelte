<script>
  export let data
</script>

{#if data}
  <section class="stack">
    <div class="row"><h1>Posts</h1><a href="/admin/posts/new">New post</a></div>
    {#each data.posts as post}
      <article class="panel row">
        <div>
          <h2>{post.title}</h2>
          <p>{post.status} · {post.category?.name || 'Uncategorized'}</p>
        </div>
        <div class="row">
          <a href={`/admin/posts/${post.id}/edit`}>Edit</a>
          <form action="?/delete" method="post">
            <input {...data.csrf.input}>
            <input type="hidden" name="id" value={post.id}>
            <button type="submit">Delete</button>
          </form>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style>
  .stack { display: grid; gap: 1rem; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
