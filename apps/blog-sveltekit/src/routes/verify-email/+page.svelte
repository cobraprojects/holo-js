<script lang="ts">
  import { type ActionData, type PageData } from './$types'

  export let data: PageData
  export let form: ActionData

  let resendMessage = ''
  let resendError = ''
  let resending = false

  async function resendVerificationEmail() {
    resending = true
    resendMessage = ''
    resendError = ''

    try {
      const response = await fetch('/api/verify-email/resend', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(data.email ? { email: data.email } : {}),
      })
      const payload = await response.json()
      if (payload?.ok === true) {
        resendMessage = payload.data?.message ?? 'A fresh verification email has been sent.'
        return
      }

      const message = Array.isArray(payload?.errors?._root)
        ? payload.errors._root[0]
        : 'Could not send another verification email.'
      resendError = typeof message === 'string' ? message : 'Could not send another verification email.'
    } finally {
      resending = false
    }
  }
</script>

<section class="panel">
  <div class="copy">
    <h1>Verify your email</h1>
    <p>Use the verification link from your inbox to confirm the account.</p>
  </div>

  {#if form?.verificationError}
    <div class="stack">
      <p class="error">{form.verificationError}</p>
      <button type="button" disabled={resending} on:click={() => { void resendVerificationEmail() }}>
        {resending ? 'Sending...' : 'Resend verification email'}
      </button>
      {#if resendMessage}
        <p class="success">{resendMessage}</p>
      {/if}
      {#if resendError}
        <p class="error">{resendError}</p>
      {/if}
    </div>
  {:else if data.hasVerificationToken}
    <form class="stack" method="POST">
      <button>Verify email</button>
    </form>
  {:else}
    <div class="stack">
      <p>
        {data.email
          ? `Check ${data.email} for the verification email, then open the link from this page.`
          : 'Check your inbox for the verification email, then open the link from this page.'}
      </p>
      <button type="button" disabled={resending} on:click={() => { void resendVerificationEmail() }}>
        {resending ? 'Sending...' : 'Resend verification email'}
      </button>
      {#if resendMessage}
        <p class="success">{resendMessage}</p>
      {/if}
      {#if resendError}
        <p class="error">{resendError}</p>
      {/if}
    </div>
  {/if}

  <div class="links">
    <a href="/register">Create another account</a>
    <a href="/login">Back to sign in</a>
  </div>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack { display: grid; gap: 0.9rem; }
  .error { color: #fca5a5; margin: 0; }
  .success { color: #86efac; }
  .links { display: flex; gap: 1rem; flex-wrap: wrap; }
  .links a { color: #7dd3fc; text-decoration: none; }
</style>
