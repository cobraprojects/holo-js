<script lang="ts">
  import { goto } from '$app/navigation'
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerForm } from '$lib/schemas/auth'

  const form = useForm(registerForm, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/register', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        await goto(submission.data.redirectTo)
      }
      return submission
    },
  })
</script>

<section class="panel">
  <div class="copy">
    <h1>Create account</h1>
    <p>Create a local user account and verify the email address before signing in.</p>
  </div>

  <form class="stack" on:submit={(event) => { event.preventDefault(); form.submit() }}>
    <label class="field">
      <span>Name</span>
      <input name="name" bind:value={form.fields.name.value} on:blur={() => form.fields.name.onBlur()} />
      {#if form.errors.has('name')}
        <span class="error">{form.errors.first('name')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Email</span>
      <input name="email" type="email" bind:value={form.fields.email.value} on:blur={() => form.fields.email.onBlur()} />
      {#if form.errors.has('email')}
        <span class="error">{form.errors.first('email')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Password</span>
      <input name="password" type="password" bind:value={form.fields.password.value} on:blur={() => form.fields.password.onBlur()} />
      {#if form.errors.has('password')}
        <span class="error">{form.errors.first('password')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Confirm password</span>
      <input
        name="passwordConfirmation"
        type="password"
        bind:value={form.fields.passwordConfirmation.value}
        on:blur={() => form.fields.passwordConfirmation.onBlur()}
      />
      {#if form.errors.has('passwordConfirmation')}
        <span class="error">{form.errors.first('passwordConfirmation')}</span>
      {/if}
    </label>

    <button disabled={form.submitting}>
      {form.submitting ? 'Creating account...' : 'Create account'}
    </button>
  </form>

  {#if form.lastSubmission?.ok === true}
    <div class="success">
      <p>Account created. Check your inbox to verify your email address.</p>
      <a href="/login">Return to sign in</a>
    </div>
  {/if}

  <a href="/login" class="link">Already have an account?</a>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .error { color: #fca5a5; }
  .success { color: #86efac; display: grid; gap: 0.5rem; }
  .success a, .link { color: #7dd3fc; text-decoration: none; }
</style>
