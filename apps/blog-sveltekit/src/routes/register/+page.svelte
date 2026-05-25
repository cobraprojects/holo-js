<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import { registerForm } from '$lib/schemas/auth'
  import type { PageData } from './$types'

  export let data: PageData

  const register = useForm(registerForm, {
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  })
  $: formError = register.errors.first('_root')
</script>

<section class="panel">
  <div class="copy">
    <h1>Create account</h1>
    <p>Create a local user account and verify the email address before signing in.</p>
  </div>

  <form class="stack" method="post">
    <input type="hidden" name={data.csrf.name} value={data.csrf.value} />

    {#if formError}
      <p class="error">{formError}</p>
    {/if}

    <label class="field">
      <span>Name</span>
      <input
        name="name"
        value={register.values.name}
        on:input={(event) => register.fields.name.onInput(event.currentTarget.value)}
        on:blur={() => register.fields.name.onBlur()}
      />
      {#if register.errors.has('name')}
        <span class="error">{register.errors.first('name')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Email</span>
      <input
        name="email"
        type="email"
        value={register.values.email}
        on:input={(event) => register.fields.email.onInput(event.currentTarget.value)}
        on:blur={() => register.fields.email.onBlur()}
      />
      {#if register.errors.has('email')}
        <span class="error">{register.errors.first('email')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Password</span>
      <input
        name="password"
        type="password"
        value={register.values.password}
        on:input={(event) => register.fields.password.onInput(event.currentTarget.value)}
        on:blur={() => register.fields.password.onBlur()}
      />
      {#if register.errors.has('password')}
        <span class="error">{register.errors.first('password')}</span>
      {/if}
    </label>

    <label class="field">
      <span>Confirm password</span>
      <input
        name="passwordConfirmation"
        type="password"
        value={register.values.passwordConfirmation}
        on:input={(event) => register.fields.passwordConfirmation.onInput(event.currentTarget.value)}
        on:blur={() => register.fields.passwordConfirmation.onBlur()}
      />
      {#if register.errors.has('passwordConfirmation')}
        <span class="error">{register.errors.first('passwordConfirmation')}</span>
      {/if}
    </label>

    <button type="submit" disabled={register.submitting}>
      {register.submitting ? 'Creating account...' : 'Create account'}
    </button>
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
