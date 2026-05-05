'use client'

import Link from 'next/link'

import { useForm } from '@holo-js/adapter-next/client'

import { forgotPasswordForm } from '@/lib/schemas/auth'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '32rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

export default function ForgotPasswordPage() {
  const form = useForm(forgotPasswordForm, {
    validateOn: 'blur',
    initialValues: { email: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/forgot-password', { method: 'POST', body: formData })
      return await response.json()
    },
  })

  return (
    <section style={panelStyle}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Forgot password</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Request a password reset link for your local account.</p>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
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

        <button type="submit" disabled={form.submitting}>
          {form.submitting ? 'Sending link...' : 'Send reset link'}
        </button>
      </form>

      {form.lastSubmission?.ok === true ? <p style={{ margin: 0, color: '#86efac' }}>A password reset link has been sent if the account exists.</p> : null}

      <Link href="/login" style={{ color: '#7dd3fc' }}>Back to sign in</Link>
    </section>
  )
}
