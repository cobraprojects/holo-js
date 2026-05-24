<script lang="ts">
  import { type ActionData, type PageData } from './$types'

  export let data: PageData
  export let form: ActionData

  $: values = form?.values ?? {}
  $: errors = form?.errors ?? {}
  $: formError = errors._root?.[0]
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
    <a href="/api/auth/clerk/login">Continue with Clerk</a>
  </div>

  <form class="stack" method="post">
    <input type="hidden" name={data.csrf.name} value={data.csrf.value}>
    {#if formError}
      <p class="error">{formError}</p>
    {/if}

    <label class="field">
      <span>Email</span>
      <input
        name="email"
        type="email"
        value={values.email ?? ''}
      />
      {#if errors.email?.[0]}
        <span class="error">{errors.email[0]}</span>
      {/if}
    </label>

    <label class="field">
      <span>Password</span>
      <input
        name="password"
        type="password"
      />
      {#if errors.password?.[0]}
        <span class="error">{errors.password[0]}</span>
      {/if}
    </label>

    <label class="remember">
      <input
        name="remember"
        type="checkbox"
        checked={values.remember === true}
      />
      Remember me
    </label>

    <button type="submit">Sign in</button>
  </form>

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
  .links a { color: #7dd3fc; text-decoration: none; }
</style>
