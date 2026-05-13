'use client'

import { type FormEvent, useState } from 'react'

type JsonResult = {
  readonly status: number
  readonly payload: unknown
}

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

export function TokenPostsClient() {
  const [tokenResult, setTokenResult] = useState<JsonResult | null>(null)
  const [postsResult, setPostsResult] = useState<JsonResult | null>(null)
  const [creatingToken, setCreatingToken] = useState(false)
  const [fetchingPosts, setFetchingPosts] = useState(false)
  const generatedToken = getStringField(tokenResult?.payload, 'token')

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreatingToken(true)
    setPostsResult(null)

    try {
      const response = await fetch('/api/v1/tokens', {
        method: 'POST',
        body: new FormData(event.currentTarget),
      })

      setTokenResult({
        status: response.status,
        payload: await readJson(response),
      })
    } finally {
      setCreatingToken(false)
    }
  }

  async function fetchPosts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFetchingPosts(true)

    const formData = new FormData(event.currentTarget)
    const token = String(formData.get('token') ?? '').trim()

    try {
      const response = await fetch('/api/v1/posts', {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
      })

      setPostsResult({
        status: response.status,
        payload: await readJson(response),
      })
    } finally {
      setFetchingPosts(false)
    }
  }

  return (
    <section style={{ display: 'grid', gap: '1rem', maxWidth: '44rem' }}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>API token posts</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Generate a bearer token from credentials, then use it to fetch protected posts.</p>
      </div>

      <form onSubmit={createToken} style={{ display: 'grid', gap: '0.9rem', padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Create token</h2>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Email</span>
          <input name="email" type="email" placeholder="editor@example.com" required />
        </label>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Password</span>
          <input name="password" type="password" placeholder="secret" required />
        </label>
        <button type="submit" disabled={creatingToken}>{creatingToken ? 'Creating...' : 'Create token'}</button>
      </form>

      {tokenResult ? (
        <section style={{ display: 'grid', gap: '0.65rem', padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Token response ({tokenResult.status})</h2>
          {generatedToken ? (
            <textarea readOnly value={generatedToken} rows={3} style={{ width: '100%', boxSizing: 'border-box' }} />
          ) : null}
          <pre style={{ margin: 0, overflowX: 'auto' }}>{JSON.stringify(tokenResult.payload, null, 2)}</pre>
        </section>
      ) : null}

      <form onSubmit={fetchPosts} style={{ display: 'grid', gap: '0.9rem', padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Fetch posts</h2>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Bearer token</span>
          <textarea name="token" rows={3} required />
        </label>
        <button type="submit" disabled={fetchingPosts}>{fetchingPosts ? 'Fetching...' : 'Fetch posts'}</button>
      </form>

      {postsResult ? (
        <section style={{ display: 'grid', gap: '0.65rem', padding: '1.25rem', borderRadius: '1rem', background: '#111827', border: '1px solid rgba(148, 163, 184, 0.16)' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Posts response ({postsResult.status})</h2>
          <pre style={{ margin: 0, overflowX: 'auto' }}>{JSON.stringify(postsResult.payload, null, 2)}</pre>
        </section>
      ) : null}
    </section>
  )
}
