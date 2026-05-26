<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { loginForm } from '$lib/schemas/auth'
  import type { PageData } from './$types'

  export let data: PageData

  const login = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
  })
  $: formError = login.errors.first('_root')
</script>

<section class="panel">
  <div class="copy">
    <h1>Super Admin Sign In</h1>
    <p>Use a super admin account to access the super admin area.</p>
  </div>

  <form class="stack" method="post">
    <input {...data.csrf.input} />

    {#if formError}
      <p class="error">{formError}</p>
    {/if}

    <label class="field">
      <span>Email</span>
      <input
        name="email"
        type="email"
        value={login.values.email}
        on:input={(event) => login.fields.email.onInput(event.currentTarget.value)}
        on:blur={() => login.fields.email.onBlur()}
      />
      {#if login.errors.has('email')}
        <span class="error">{login.errors.first('email')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Password</span>
      <input
        name="password"
        type="password"
        value={login.values.password}
        on:input={(event) => login.fields.password.onInput(event.currentTarget.value)}
        on:blur={() => login.fields.password.onBlur()}
      />
      {#if login.errors.has('password')}
        <span class="error">{login.errors.first('password')}</span>
      {/if}
    </label>

    <label class="remember">
      <input
        name="remember"
        type="checkbox"
        checked={login.values.remember}
        on:change={(event) => login.fields.remember.onInput(event.currentTarget.checked)}
      />
      Remember me
    </label>

    <button type="submit" disabled={login.submitting}>
      {login.submitting ? 'Signing in...' : 'Sign in as super admin'}
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
