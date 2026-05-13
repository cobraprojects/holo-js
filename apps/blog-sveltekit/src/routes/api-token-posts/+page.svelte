<script lang="ts">
  type JsonResult = {
    readonly status: number
    readonly payload: unknown
  }

  let tokenResult = $state<JsonResult | null>(null)
  let postsResult = $state<JsonResult | null>(null)
  let creatingToken = $state(false)
  let fetchingPosts = $state(false)

  const generatedToken = $derived(getStringField(tokenResult?.payload, 'token'))

  function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
  }

  function getStringField(value: unknown, field: string): string {
    if (!isRecord(value)) {
      return ''
    }

    const fieldValue = value[field]
    return typeof fieldValue === 'string' ? fieldValue : ''
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return {
        ok: false,
        message: 'Response was not valid JSON.',
      }
    }
  }

  async function createToken(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return
    }

    creatingToken = true
    postsResult = null

    try {
      const response = await fetch('/api/v1/tokens', {
        method: 'POST',
        body: new FormData(event.currentTarget),
      })

      tokenResult = {
        status: response.status,
        payload: await readJson(response),
      }
    } finally {
      creatingToken = false
    }
  }

  async function fetchPosts(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!(event.currentTarget instanceof HTMLFormElement)) {
      return
    }

    fetchingPosts = true
    const formData = new FormData(event.currentTarget)
    const token = String(formData.get('token') ?? '').trim()

    try {
      const response = await fetch('/api/v1/posts', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })

      postsResult = {
        status: response.status,
        payload: await readJson(response),
      }
    } finally {
      fetchingPosts = false
    }
  }
</script>

<section class="token-page">
  <div>
    <h1>API token posts</h1>
    <p>Generate a bearer token from credentials, then use it to fetch protected posts.</p>
  </div>

  <form class="panel" onsubmit={createToken}>
    <h2>Create token</h2>
    <label class="field">
      <span>Email</span>
      <input name="email" type="email" placeholder="editor@example.com" required />
    </label>
    <label class="field">
      <span>Password</span>
      <input name="password" type="password" placeholder="secret-secret" required />
    </label>
    <button type="submit" disabled={creatingToken}>{creatingToken ? 'Creating...' : 'Create token'}</button>
  </form>

  {#if tokenResult}
    <section class="panel">
      <h2>Token response ({tokenResult.status})</h2>
      {#if generatedToken}
        <textarea value={generatedToken} readonly rows="3"></textarea>
      {/if}
      <pre>{JSON.stringify(tokenResult.payload, null, 2)}</pre>
    </section>
  {/if}

  <form class="panel" onsubmit={fetchPosts}>
    <h2>Fetch posts</h2>
    <label class="field">
      <span>Bearer token</span>
      <textarea name="token" rows="3" required></textarea>
    </label>
    <button type="submit" disabled={fetchingPosts}>{fetchingPosts ? 'Fetching...' : 'Fetch posts'}</button>
  </form>

  {#if postsResult}
    <section class="panel">
      <h2>Posts response ({postsResult.status})</h2>
      <pre>{JSON.stringify(postsResult.payload, null, 2)}</pre>
    </section>
  {/if}
</section>

<style>
  .token-page {
    display: grid;
    gap: 1rem;
    max-width: 44rem;
  }
  .token-page h1 {
    margin: 0 0 0.5rem 0;
  }
  .token-page p {
    margin: 0;
    color: #94a3b8;
  }
  .panel {
    display: grid;
    gap: 0.9rem;
    padding: 1.25rem;
    border-radius: 1rem;
    background: #111827;
    border: 1px solid rgba(148, 163, 184, 0.16);
  }
  .panel h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .field {
    display: grid;
    gap: 0.35rem;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  pre {
    margin: 0;
    overflow-x: auto;
  }
</style>
