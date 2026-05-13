<script setup lang="ts">
type JsonResult = {
  readonly status: number
  readonly payload: unknown
}

const tokenResult = ref<JsonResult | null>(null)
const postsResult = ref<JsonResult | null>(null)
const creatingToken = ref(false)
const fetchingPosts = ref(false)

const generatedToken = computed(() => getStringField(tokenResult.value?.payload, 'token'))

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

async function createToken(event: Event): Promise<void> {
  event.preventDefault()
  if (!(event.currentTarget instanceof HTMLFormElement)) {
    return
  }

  creatingToken.value = true
  postsResult.value = null

  try {
    const response = await fetch('/api/v1/tokens', {
      method: 'POST',
      body: new FormData(event.currentTarget),
    })

    tokenResult.value = {
      status: response.status,
      payload: await readJson(response),
    }
  } finally {
    creatingToken.value = false
  }
}

async function fetchPosts(event: Event): Promise<void> {
  event.preventDefault()
  if (!(event.currentTarget instanceof HTMLFormElement)) {
    return
  }

  fetchingPosts.value = true
  const formData = new FormData(event.currentTarget)
  const token = String(formData.get('token') ?? '').trim()

  try {
    const response = await fetch('/api/v1/posts', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })

    postsResult.value = {
      status: response.status,
      payload: await readJson(response),
    }
  } finally {
    fetchingPosts.value = false
  }
}
</script>

<template>
  <section class="token-page">
    <div>
      <h1>API token posts</h1>
      <p>Generate a bearer token from credentials, then use it to fetch protected posts.</p>
    </div>

    <form class="panel" @submit="createToken">
      <h2>Create token</h2>
      <label class="field">
        <span>Email</span>
        <input name="email" type="email" placeholder="editor@example.com" required>
      </label>
      <label class="field">
        <span>Password</span>
        <input name="password" type="password" placeholder="secret" required>
      </label>
      <button type="submit" :disabled="creatingToken">
        {{ creatingToken ? 'Creating...' : 'Create token' }}
      </button>
    </form>

    <section v-if="tokenResult" class="panel">
      <h2>Token response ({{ tokenResult.status }})</h2>
      <textarea v-if="generatedToken" :value="generatedToken" readonly rows="3" />
      <pre>{{ JSON.stringify(tokenResult.payload, null, 2) }}</pre>
    </section>

    <form class="panel" @submit="fetchPosts">
      <h2>Fetch posts</h2>
      <label class="field">
        <span>Bearer token</span>
        <textarea name="token" rows="3" required />
      </label>
      <button type="submit" :disabled="fetchingPosts">
        {{ fetchingPosts ? 'Fetching...' : 'Fetch posts' }}
      </button>
    </form>

    <section v-if="postsResult" class="panel">
      <h2>Posts response ({{ postsResult.status }})</h2>
      <pre>{{ JSON.stringify(postsResult.payload, null, 2) }}</pre>
    </section>
  </section>
</template>

<style scoped>
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
