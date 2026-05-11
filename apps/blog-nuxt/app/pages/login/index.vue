<script setup lang="ts">
import { useAuth } from '@holo-js/auth/nuxt'
import { useForm } from '@holo-js/adapter-nuxt/client'
import { loginForm } from '#shared/schemas/auth'

const { refreshUser } = await useAuth()
const form = useForm(loginForm, {
  validateOn: 'blur',
  initialValues: { email: '', password: '', remember: false },
  async submitter({ formData }) {
    const submission = await $fetch('/api/login', { method: 'POST', body: formData })
    if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
      try {
        await refreshUser()
      } catch (error) {
        console.warn('Auth refresh failed after login.', error)
      }

      await navigateTo(submission.data.redirectTo, {
        external: true,
      })
    }
    return submission
  },
})
</script>

<template>
  <section class="panel">
    <div class="copy">
      <h1>Sign in</h1>
      <p>Use your email address and password to access the admin area.</p>
    </div>

    <div class="social-links">
      <a href="/auth/google">Continue with Google</a>
      <a href="/auth/github">Continue with GitHub</a>
      <a href="/api/auth/workos/login">Continue with WorkOS</a>
    </div>

    <form class="stack" @submit.prevent="form.submit()">
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

      <label class="remember">
        <input name="remember" type="checkbox" v-model="form.values.remember" />
        Remember me
      </label>

      <button :disabled="form.submitting">
        {{ form.submitting ? 'Signing in...' : 'Sign in' }}
      </button>
    </form>

    <div v-if="form.lastSubmission?.ok === true" class="success">
      <p>Signed in successfully.</p>
      <NuxtLink to="/admin">Continue to admin</NuxtLink>
    </div>

    <div class="links">
      <NuxtLink to="/register">Create account</NuxtLink>
      <NuxtLink to="/forgot-password">Forgot password?</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.panel { display: grid; gap: 1rem; max-width: 32rem; padding: 1.5rem; border-radius: 1rem; background: #111827; border: 1px solid rgba(148, 163, 184, 0.16); }
.copy p { margin: 0; color: #94a3b8; }
.stack, .field { display: grid; gap: 0.35rem; }
.stack { gap: 0.9rem; }
.social-links { display: grid; gap: 0.65rem; }
.social-links a { color: #e5e7eb; text-decoration: none; }
.remember, .links { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.error { color: #fca5a5; }
.success { color: #86efac; }
.links a, .success a { color: #7dd3fc; }
</style>
