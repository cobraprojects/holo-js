'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

import { useForm } from '@holo-js/adapter-next/client'

import { registerForm } from '@/lib/schemas/auth'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '36rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

export default function RegisterPage() {
  const router = useRouter()
  const form = useForm(registerForm, {
    csrf: true,
    validateOn: 'blur',
    initialValues: { name: '', email: '', password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/register', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission?.ok === true) {
        router.replace('/login')
      }
      return submission
    },
  })

  return (
    <section style={panelStyle}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Create account</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Create a local user account and verify the email address before signing in.</p>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Name</span>
          <input
            name="name"
            value={form.values.name}
            onInput={(event) => form.fields.name.onInput(event.currentTarget.value)}
            onBlur={() => form.fields.name.onBlur()}
          />
          {form.errors.has('name') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('name')}</span> : null}
        </label>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={form.values.email}
            onInput={(event) => form.fields.email.onInput(event.currentTarget.value)}
            onBlur={() => form.fields.email.onBlur()}
          />
          {form.errors.has('email') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('email')}</span> : null}
        </label>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={form.values.password}
            onInput={(event) => form.fields.password.onInput(event.currentTarget.value)}
            onBlur={() => form.fields.password.onBlur()}
          />
          {form.errors.has('password') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('password')}</span> : null}
        </label>

        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Confirm password</span>
          <input
            name="passwordConfirmation"
            type="password"
            value={form.values.passwordConfirmation}
            onInput={(event) => form.fields.passwordConfirmation.onInput(event.currentTarget.value)}
            onBlur={() => form.fields.passwordConfirmation.onBlur()}
          />
          {form.errors.has('passwordConfirmation') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('passwordConfirmation')}</span> : null}
        </label>

        <button type="submit" disabled={form.submitting}>
          {form.submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>

      {form.lastSubmission?.ok === true ? (
        <div style={{ color: '#86efac', display: 'grid', gap: '0.5rem' }}>
          <p style={{ margin: 0 }}>Account created. Check your inbox to verify your email address.</p>
          <Link href="/login" style={{ color: '#7dd3fc' }}>Return to sign in</Link>
        </div>
      ) : null}

      <Link href="/login" style={{ color: '#7dd3fc' }}>Already have an account?</Link>
      <a href="/api/auth/workos/register" style={{ color: '#7dd3fc' }}>Register with WorkOS</a>
      <a href="/api/auth/clerk/register" style={{ color: '#7dd3fc' }}>Register with Clerk</a>
    </section>
  )
}
