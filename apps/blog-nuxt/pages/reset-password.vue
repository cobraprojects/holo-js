<script setup lang="ts">
import { useRoute } from '#imports'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { resetPasswordForm } from '~/lib/schemas/auth'

const route = useRoute()
const token = typeof route.query.token === 'string' ? route.query.token : ''

const form = useForm(resetPasswordForm, {
  validateOn: 'blur',
  initialValues: { token, password: '', passwordConfirmation: '' },
  async submitter({ formData }) {
    return await $fetch('/api/reset-password', { method: 'POST', body: formData })
  },
})
</script>

<template>
  <section class="panel">
    <div class="copy">
      <h1>Reset password</h1>
      <p>Set a new password using the reset link from your email.</p>
    </div>

    <form v-if="token" class="stack" @submit.prevent="form.submit()">
      <input name="token" type="hidden" :value="form.values.token">

      <label class="field">
        <span>New password</span>
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

      <span v-if="form.errors.has('token')" class="error">{{ form.errors.first('token') }}</span>

      <button :disabled="form.submitting">
        {{ form.submitting ? 'Resetting password...' : 'Reset password' }}
      </button>
    </form>

    <p v-else class="error">A reset token is required to complete this form.</p>

    <div v-if="form.lastSubmission?.ok === true" class="success">
      <p>Your password has been reset successfully.</p>
      <NuxtLink to="/login">Sign in</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
.copy p { margin: 0; color: #94a3b8; }
.stack, .field { display: grid; gap: 0.35rem; }
.stack { gap: 0.9rem; }
.error { color: #fca5a5; margin: 0; }
.success { color: #86efac; }
a { color: #7dd3fc; text-decoration: none; }
</style>
