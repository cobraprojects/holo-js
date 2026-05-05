'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { useForm } from '@holo-js/adapter-next/client'

import { resetPasswordForm } from '@/lib/schemas/auth'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '36rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

function ResetPasswordPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const form = useForm(resetPasswordForm, {
    validateOn: 'blur',
    initialValues: { token, password: '', passwordConfirmation: '' },
    async submitter({ formData }) {
      const response = await fetch('/api/reset-password', { method: 'POST', body: formData })
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
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Reset password</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Set a new password using the reset link from your email.</p>
      </div>

      {token.length > 0 ? (
        <form onSubmit={(event) => { event.preventDefault(); form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
          <input name="token" type="hidden" value={form.fields.token.value} />

          <label style={{ display: 'grid', gap: '0.35rem' }}>
            <span>New password</span>
            <input
              name="password"
              type="password"
              value={form.fields.password.value}
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
              value={form.fields.passwordConfirmation.value}
              onInput={(event) => form.fields.passwordConfirmation.onInput(event.currentTarget.value)}
              onBlur={() => form.fields.passwordConfirmation.onBlur()}
            />
            {form.errors.has('passwordConfirmation') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('passwordConfirmation')}</span> : null}
          </label>

          {form.errors.has('token') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('token')}</span> : null}

          <button type="submit" disabled={form.submitting}>
            {form.submitting ? 'Resetting password...' : 'Reset password'}
          </button>
        </form>
      ) : (
        <p style={{ margin: 0, color: '#fca5a5' }}>A reset token is required to complete this form.</p>
      )}

      {form.lastSubmission?.ok === true ? (
        <div style={{ color: '#86efac' }}>
          <p style={{ marginTop: 0 }}>Your password has been reset successfully.</p>
          <Link href="/login" style={{ color: '#7dd3fc' }}>Sign in</Link>
        </div>
      ) : null}
    </section>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<section style={panelStyle}><p style={{ margin: 0 }}>Loading reset form…</p></section>}>
      <ResetPasswordPageContent />
    </Suspense>
  )
}
