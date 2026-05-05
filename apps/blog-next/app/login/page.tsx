'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/auth'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '32rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

export default function LoginPage() {
  const router = useRouter()
  const form = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      const response = await fetch('/api/login', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        router.replace(submission.data.redirectTo)
      }
      return submission
    },
  })

  return (
    <section style={panelStyle}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Sign in</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Use your email address and password to access the admin area.</p>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
        <label style={{ display: 'grid', gap: '0.35rem' }}>
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={form.fields.email.value}
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
            value={form.fields.password.value}
            onInput={(event) => form.fields.password.onInput(event.currentTarget.value)}
            onBlur={() => form.fields.password.onBlur()}
          />
          {form.errors.has('password') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('password')}</span> : null}
        </label>

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            name="remember"
            type="checkbox"
            checked={form.fields.remember.value}
            onChange={(event) => form.fields.remember.onInput(event.currentTarget.checked)}
          />
          Remember me
        </label>

        <button type="submit" disabled={form.submitting}>
          {form.submitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      {form.lastSubmission?.ok === true ? (
        <div style={{ color: '#86efac' }}>
          <p style={{ marginTop: 0 }}>Signed in successfully.</p>
          <Link href="/admin" style={{ color: '#7dd3fc' }}>Continue to admin</Link>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <Link href="/register" style={{ color: '#7dd3fc' }}>Create account</Link>
        <Link href="/forgot-password" style={{ color: '#7dd3fc' }}>Forgot password?</Link>
      </div>
    </section>
  )
}
