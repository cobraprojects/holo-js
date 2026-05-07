<script setup lang="ts">
import { useForm } from '@holo-js/adapter-nuxt/client'
import { forgotPasswordForm } from '#shared/schemas/auth'

const form = useForm(forgotPasswordForm, {
  validateOn: 'blur',
  initialValues: { email: '' },
  async submitter({ formData }) {
    return await $fetch('/api/forgot-password', { method: 'POST', body: formData })
  },
})
</script>

<template>
  <section class="panel">
    <div class="copy">
      <h1>Forgot password</h1>
      <p>Request a password reset link for your local account.</p>
    </div>

    <form class="stack" @submit.prevent="form.submit()">
      <label class="field">
        <span>Email</span>
        <input name="email" type="email" v-model="form.values.email" @blur="form.fields.email.onBlur()" />
        <span v-if="form.errors.has('email')" class="error">{{ form.errors.first('email') }}</span>
      </label>

      <button :disabled="form.submitting">
        {{ form.submitting ? 'Sending link...' : 'Send reset link' }}
      </button>
    </form>

    <p v-if="form.lastSubmission?.ok === true" class="success">A password reset link has been sent if the account exists.</p>
    <NuxtLink to="/login">Back to sign in</NuxtLink>
  </section>
</template>

<style scoped>
.panel { display: grid; gap: 1rem; max-width: 32rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
.copy p { margin: 0; color: #94a3b8; }
.stack, .field { display: grid; gap: 0.35rem; }
.stack { gap: 0.9rem; }
.error { color: #fca5a5; }
.success { color: #86efac; margin: 0; }
a { color: #7dd3fc; text-decoration: none; }
</style>
