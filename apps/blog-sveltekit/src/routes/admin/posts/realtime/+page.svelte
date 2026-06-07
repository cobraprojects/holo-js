<script>
  import { adminPosts, renameAdminPost } from '../../../../../server/realtime/posts'

  const data = adminPosts()
  let selectedPostId = null
  let title = ''
  let saving = false

  function selectPost(post) {
    selectedPostId = post.id
    title = `${post.title} updated`
  }

  async function savePost() {
    if (!selectedPostId) {
      return
    }

    saving = true
    try {
      await renameAdminPost({ id: selectedPostId, title })
    } finally {
      saving = false
    }
  }
</script>

<section class="stack">
  <div class="row"><h1>Realtime posts</h1><a href="/admin/posts">Posts</a></div>
  <form class="editor" on:submit|preventDefault={savePost}>
    <input bind:value={title} aria-label="Realtime post title">
    <button type="submit" disabled={!selectedPostId || saving}>Save realtime title</button>
  </form>
  {#each data.posts || [] as post (post.id)}
    <article class="panel row" data-post-id={post.id}>
      <div>
        <h2>{post.title}</h2>
        <p>{post.status} · {post.category?.name || 'Uncategorized'} · {post.tags.map((tag) => tag.name).join(', ') || 'No tags'}</p>
      </div>
      <button type="button" on:click={() => selectPost(post)}>Edit title</button>
    </article>
  {/each}
</section>

<style>
  .stack { display: grid; gap: 1rem; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .editor { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .editor input { min-width: 18rem; flex: 1 1 18rem; }
  .panel { padding: 1rem; border-radius: 1rem; background: #111827; }
</style>
