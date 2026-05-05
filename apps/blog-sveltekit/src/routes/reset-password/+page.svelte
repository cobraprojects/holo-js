<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { resetPasswordForm } from '$lib/schemas/auth'

  export let data: {
    token: string
  }

  const form = useForm(resetPasswordForm, {
    validateOn: 'blur',
    initialValues: { token: data.token, password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/reset-password', { method: 'POST', body: formData })
      return await response.json()
    },
  })
</script>

<section class="panel">
  <div class="copy">
    <h1>Reset password</h1>
    <p>Set a new password using the reset link from your email.</p>
  </div>

  {#if data.token}
    <form class="stack" on:submit={(event) => { event.preventDefault(); form.submit() }}>
      <input name="token" type="hidden" value={form.values.token} />

      <label class="field">
        <span>New password</span>
        <input
          name="password"
          type="password"
          value={form.values.password}
          on:input={(event) => form.fields.password.onInput(event.currentTarget.value)}
          on:blur={() => form.fields.password.onBlur()}
        />
        {#if form.errors.has('password')}
          <span class="error">{form.errors.first('password')}</span>
        {/if}
      </label>

      <label class="field">
        <span>Confirm password</span>
        <input
          name="passwordConfirmation"
          type="password"
          value={form.values.passwordConfirmation}
          on:input={(event) => form.fields.passwordConfirmation.onInput(event.currentTarget.value)}
          on:blur={() => form.fields.passwordConfirmation.onBlur()}
        />
        {#if form.errors.has('passwordConfirmation')}
          <span class="error">{form.errors.first('passwordConfirmation')}</span>
        {/if}
      </label>

      {#if form.errors.has('token')}
        <span class="error">{form.errors.first('token')}</span>
      {/if}

      <button disabled={form.submitting}>
        {form.submitting ? 'Resetting password...' : 'Reset password'}
      </button>
    </form>
  {:else}
    <p class="error">A reset token is required to complete this form.</p>
  {/if}

  {#if form.lastSubmission?.ok === true}
    <div class="success">
      <p>Your password has been reset successfully.</p>
      <a href="/login">Sign in</a>
    </div>
  {/if}
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .error { color: #fca5a5; margin: 0; }
  .success { color: #86efac; }
  .success a { color: #7dd3fc; text-decoration: none; }
</style>
