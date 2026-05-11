<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/auth'

  const auth = useAuth()
  const form = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        await auth.refreshUser()
        await invalidateAll()
        await goto(submission.data.redirectTo)
      }
      return submission
    },
  })
</script>

<section class="panel">
  <div class="copy">
    <h1>Sign in</h1>
    <p>Use your email address and password to access the admin area.</p>
  </div>

  <div class="social-links">
    <a href="/auth/google">Continue with Google</a>
    <a href="/auth/github">Continue with GitHub</a>
    <a href="/api/auth/workos/login">Continue with WorkOS</a>
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

    <label class="field">
      <span>Password</span>
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

    <label class="remember">
      <input
        name="remember"
        type="checkbox"
        checked={form.values.remember}
        on:change={(event) => form.fields.remember.onInput(event.currentTarget.checked)}
      />
      Remember me
    </label>

    <button disabled={form.submitting}>
      {form.submitting ? 'Signing in...' : 'Sign in'}
    </button>
  </form>

  {#if form.lastSubmission?.ok === true}
    <div class="success">
      <p>Signed in successfully.</p>
      <a href="/admin">Continue to admin</a>
    </div>
  {/if}

  <div class="links">
    <a href="/register">Create account</a>
    <a href="/forgot-password">Forgot password?</a>
  </div>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 32rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .social-links { display: grid; gap: 0.65rem; }
  .social-links a { color: #e5e7eb; text-decoration: none; }
  .remember, .links { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .error { color: #fca5a5; }
  .success { color: #86efac; }
  .success a, .links a { color: #7dd3fc; text-decoration: none; }
</style>
