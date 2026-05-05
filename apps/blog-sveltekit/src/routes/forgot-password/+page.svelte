<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { forgotPasswordForm } from '$lib/schemas/auth'

  const form = useForm(forgotPasswordForm, {
    validateOn: 'blur',
    initialValues: { email: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/forgot-password', { method: 'POST', body: formData })
      return await response.json()
    },
  })
</script>

<section class="panel">
  <div class="copy">
    <h1>Forgot password</h1>
    <p>Request a password reset link for your local account.</p>
  </div>

  <form class="stack" on:submit={(event) => { event.preventDefault(); form.submit() }}>
    <label class="field">
      <span>Email</span>
      <input
        name="email"
        type="email"
        value={form.values.email}
        on:input={(event) => form.fields.email.onInput(event.currentTarget.value)}
        on:blur={() => form.fields.email.onBlur()}
      />
      {#if form.errors.has('email')}
        <span class="error">{form.errors.first('email')}</span>
      {/if}
    </label>

    <button disabled={form.submitting}>
      {form.submitting ? 'Sending link...' : 'Send reset link'}
    </button>
  </form>

  {#if form.lastSubmission?.ok === true}
    <p class="success">A password reset link has been sent if the account exists.</p>
  {/if}

  <a href="/login" class="link">Back to sign in</a>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 32rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .error { color: #fca5a5; }
  .success { color: #86efac; margin: 0; }
  .link { color: #7dd3fc; text-decoration: none; }
</style>
