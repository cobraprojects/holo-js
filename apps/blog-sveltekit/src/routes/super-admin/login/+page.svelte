<script lang="ts">
  import { type ActionData } from './$types'

  export let form: ActionData

  $: values = form?.values ?? {}
  $: errors = form?.errors ?? {}
  $: formError = errors._root?.[0]
</script>

<section class="panel">
  <div class="copy">
    <h1>Super Admin Sign In</h1>
    <p>Use a super admin account to access the super admin area.</p>
  </div>

  <form class="stack" method="post">
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

    <button type="submit">Sign in as super admin</button>
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
