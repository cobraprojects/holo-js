<script setup lang="ts">
import { navigateTo } from '#imports'
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { registerForm } from '#shared/schemas/auth'

const { refreshUser } = await useAuth()
const form = useForm(registerForm, {
  validateOn: 'blur',
  initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
  async submitter({ formData }) {
    const submission = await $fetch('/api/register', { method: 'POST', body: formData })
    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      await refreshUser()
      await navigateTo(submission.data.redirectTo, {
        redirectCode: 302,
      })
    }
    return submission
  },
})
</script>

<template>
  <section class="panel">
    <div class="copy">
      <h1>Create account</h1>
      <p>Create a local user account and verify the email address before signing in.</p>
    </div>

    <form class="stack" @submit.prevent="form.submit()">
      <label class="field">
        <span>Name</span>
        <input name="name" v-model="form.values.name" @blur="form.fields.name.onBlur()" />
        <span v-if="form.errors.has('name')" class="error">{{ form.errors.first('name') }}</span>
      </label>

      <label class="field">
        <span>Email</span>
        <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
        <span v-if="form.errors.has('email')" class="error">{{ form.errors.first('email') }}</span>
      </label>

      <label class="field">
        <span>Password</span>
        <input name="password" type="password" v-model="form.values.password" @blur="form.fields.password.onBlur()" />
        <span v-if="form.errors.has('password')" class="error">{{ form.errors.first('password') }}</span>
      </label>

      <label class="field">
        <span>Confirm password</span>
        <input
          name="passwordConfirmation"
          type="password"
          v-model="form.values.passwordConfirmation"
          @blur="form.fields.passwordConfirmation.onBlur()"
        />
        <span v-if="form.errors.has('passwordConfirmation')" class="error">{{ form.errors.first('passwordConfirmation') }}</span>
      </label>

      <button :disabled="form.submitting">
        {{ form.submitting ? 'Creating account...' : 'Create account' }}
      </button>
    </form>

    <div v-if="form.lastSubmission?.ok === true" class="success">
      <p>Account created. Check your inbox to verify your email address.</p>
      <NuxtLink to="/login">Return to sign in</NuxtLink>
    </div>

    <NuxtLink to="/login">Already have an account?</NuxtLink>
    <a href="/api/auth/workos/register">Register with WorkOS</a>
  </section>
</template>

<style scoped>
.panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
.copy p { margin: 0; color: #94a3b8; }
.stack, .field { display: grid; gap: 0.35rem; }
.stack { gap: 0.9rem; }
.error { color: #fca5a5; }
.success { color: #86efac; display: grid; gap: 0.5rem; }
a { color: #7dd3fc; text-decoration: none; }
</style>
