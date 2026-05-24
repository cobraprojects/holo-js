<script lang="ts">
  import { goto } from '$app/navigation'
  import { useAuth } from '@holo-js/auth/sveltekit/client'
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/auth'

  const auth = useAuth({ guard: 'admin' })
  const form = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      const response = await fetch('/api/super-admin/login', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission.ok === true && typeof submission.data?.redirectTo === 'string') {
        await auth.refreshUser()
        await goto(submission.data.redirectTo, { invalidateAll: true })
      }

      return submission
    },
  })
  $: formError = form.errors.first('_root')
</script>

<section class="panel">
  <div class="copy">
    <h1>Super Admin Sign In</h1>
    <p>Use a super admin account to access the super admin area.</p>
  </div>

  <form class="stack" on:submit={(event) => { event.preventDefault(); void form.submit() }}>
    {#if formError}
      <p class="error">{formError}</p>
    {/if}

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

    <button type="submit" disabled={form.submitting}>
      {form.submitting ? 'Signing in...' : 'Sign in as super admin'}
    </button>
  </form>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 32rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .remember { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .error { color: #fca5a5; }
</style>
