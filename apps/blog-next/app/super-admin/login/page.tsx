'use client'

import { useForm } from '@holo-js/adapter-next/client'
import { loginForm } from '@/lib/schemas/auth'
import { superAdminLoginAction } from './actions'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '32rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

export default function SuperAdminLoginPage() {
  const form = useForm(loginForm, {
    validateOn: 'blur',
    initialValues: { email: '', password: '', remember: false },
    async submitter({ formData }) {
      return await superAdminLoginAction(formData)
    },
  })
  const formError = form.errors.first('_root')

  return (
    <section style={panelStyle}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Super Admin Sign In</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Use a super admin account to access the super admin area.</p>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
        {formError ? <p style={{ margin: 0, color: '#fca5a5' }}>{formError}</p> : null}

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

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            name="remember"
            type="checkbox"
            checked={form.values.remember}
            onChange={(event) => form.fields.remember.onInput(event.currentTarget.checked)}
          />
          Remember me
        </label>

        <button type="submit" disabled={form.submitting}>
          {form.submitting ? 'Signing in...' : 'Sign in as super admin'}
        </button>
      </form>

    </section>
  )
}
