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
    <h1>Create account</h1>
    <p>Create a local user account and verify the email address before signing in.</p>
  </div>

  <form class="stack" method="post">
    <input type="hidden" name={data.csrf.name} value={data.csrf.value}>
    {#if formError}
      <p class="error">{formError}</p>
    {/if}

    <label class="field">
      <span>Name</span>
      <input
        name="name"
        value={values.name ?? ''}
      />
      {#if errors.name?.[0]}
        <span class="error">{errors.name[0]}</span>
      {/if}
    </label>

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

    <label class="field">
      <span>Confirm password</span>
      <input
        name="passwordConfirmation"
        type="password"
      />
      {#if errors.passwordConfirmation?.[0]}
        <span class="error">{errors.passwordConfirmation[0]}</span>
      {/if}
    </label>

    <button type="submit">Create account</button>
  </form>

  <a href="/login" class="link">Already have an account?</a>
  <a href="/api/auth/workos/register" class="link">Register with WorkOS</a>
  <a href="/api/auth/clerk/register" class="link">Register with Clerk</a>
</section>

<style>
  .panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
  .copy p { margin: 0; color: #94a3b8; }
  .stack, .field { display: grid; gap: 0.35rem; }
  .stack { gap: 0.9rem; }
  .error { color: #fca5a5; }
  .link { color: #7dd3fc; text-decoration: none; }
</style>
