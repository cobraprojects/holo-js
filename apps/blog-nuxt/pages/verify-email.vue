<script setup lang="ts">
import { useRoute } from '#imports'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { ref } from 'vue'
import { verifyEmailForm } from '~/lib/schemas/auth'

const route = useRoute()
const token = typeof route.query.token === 'string' ? route.query.token : ''
const email = typeof route.query.email === 'string' ? route.query.email : ''
const resendMessage = ref('')
const resendError = ref('')
const resending = ref(false)

const form = useForm(verifyEmailForm, {
  initialValues: { token },
  async submitter({ formData }) {
    return await $fetch('/api/verify-email', { method: 'POST', body: formData })
  },
})

async function resendVerificationEmail() {
  resending.value = true
  resendMessage.value = ''
  resendError.value = ''

  try {
    const payload = await $fetch('/api/verify-email/resend', {
      method: 'POST',
      body: email ? { email } : {},
    })
    if (payload?.ok === true) {
      resendMessage.value = payload.data?.message ?? 'A fresh verification email has been sent.'
      return
    }

    const message = Array.isArray(payload?.errors?._root)
      ? payload.errors._root[0]
      : 'Could not send another verification email.'
    resendError.value = typeof message === 'string' ? message : 'Could not send another verification email.'
  } catch {
    resendError.value = 'Could not send another verification email.'
  } finally {
    resending.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="copy">
      <h1>Verify your email</h1>
      <p>Use the verification link from your inbox to confirm the account.</p>
    </div>

    <form v-if="token" class="stack" @submit.prevent="form.submit()">
      <input name="token" type="hidden" v-model="form.values.token">
      <span v-if="form.errors.has('token')" class="error">{{ form.errors.first('token') }}</span>
      <button :disabled="form.submitting">
        {{ form.submitting ? 'Verifying...' : 'Verify email' }}
      </button>
    </form>

    <div v-else class="stack">
      <p>
        {{ email
          ? `Check ${email} for the verification email, then open the link from this page.`
          : 'Check your inbox for the verification email, then open the link from this page.' }}
      </p>
      <button type="button" :disabled="resending" @click="resendVerificationEmail">
        {{ resending ? 'Sending...' : 'Resend verification email' }}
      </button>
      <p v-if="resendMessage" class="success">{{ resendMessage }}</p>
      <p v-if="resendError" class="error">{{ resendError }}</p>
    </div>

    <div v-if="form.lastSubmission?.ok === true" class="success">
      <p>Your email address has been verified.</p>
      <NuxtLink to="/login">Sign in</NuxtLink>
    </div>

    <div class="links">
      <NuxtLink to="/register">Create another account</NuxtLink>
      <NuxtLink to="/login">Back to sign in</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.panel { display: grid; gap: 1rem; max-width: 36rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
.copy p { margin: 0; color: #94a3b8; }
.stack { display: grid; gap: 0.9rem; }
.error { color: #fca5a5; margin: 0; }
.success { color: #86efac; }
.links { display: flex; gap: 1rem; flex-wrap: wrap; }
a { color: #7dd3fc; text-decoration: none; }
</style>
