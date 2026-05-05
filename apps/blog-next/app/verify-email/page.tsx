'use client'

import { Suspense } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'

import { useForm } from '@holo-js/adapter-next/client'

import { verifyEmailForm } from '@/lib/schemas/auth'

const panelStyle = {
  display: 'grid',
  gap: '1rem',
  maxWidth: '36rem',
  padding: '1.5rem',
  borderRadius: '1rem',
  background: '#111827',
  border: '1px solid rgba(148, 163, 184, 0.16)',
} satisfies React.CSSProperties

function VerifyEmailPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const email = searchParams.get('email') ?? ''
  const [resendMessage, setResendMessage] = useState<string>('')
  const [resendError, setResendError] = useState<string>('')
  const [resending, setResending] = useState(false)

  const form = useForm(verifyEmailForm, {
    initialValues: { token },
    async submitter({ formData }) {
      const response = await fetch('/api/verify-email', { method: 'POST', body: formData })
      const submission = await response.json()
      if (submission?.ok === true && typeof submission.data?.redirectTo === 'string') {
        router.replace(submission.data.redirectTo)
      }
      return submission
    },
  })

  async function resendVerificationEmail() {
    setResending(true)
    setResendError('')
    setResendMessage('')

    try {
      const response = await fetch('/api/verify-email/resend', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(email ? { email } : {}),
      })
      const payload = await response.json()
      if (payload?.ok === true) {
        setResendMessage(payload.data?.message ?? 'A fresh verification email has been sent.')
        return
      }

      const message = Array.isArray(payload?.errors?._root)
        ? payload.errors._root[0]
        : 'Could not send another verification email.'
      setResendError(typeof message === 'string' ? message : 'Could not send another verification email.')
    } catch (error) {
      console.error('Failed to resend verification email.', error)
      setResendError('Could not send another verification email.')
    } finally {
      setResending(false)
    }
  }

  return (
    <section style={panelStyle}>
      <div>
        <h1 style={{ margin: '0 0 0.5rem 0' }}>Verify your email</h1>
        <p style={{ margin: 0, color: '#94a3b8' }}>Use the verification link from your inbox to confirm the account.</p>
      </div>

      {token.length > 0 ? (
        <form onSubmit={(event) => { event.preventDefault(); form.submit() }} style={{ display: 'grid', gap: '0.9rem' }}>
          <input name="token" type="hidden" value={form.values.token} />
          {form.errors.has('token') ? <span style={{ color: '#fca5a5' }}>{form.errors.first('token')}</span> : null}
          <button type="submit" disabled={form.submitting}>
            {form.submitting ? 'Verifying...' : 'Verify email'}
          </button>
        </form>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <p style={{ margin: 0 }}>
            {email
              ? `Check ${email} for the verification email, then open the link from this page.`
              : 'Check your inbox for the verification email, then open the link from this page.'}
          </p>
          <button type="button" onClick={() => { void resendVerificationEmail() }} disabled={resending}>
            {resending ? 'Sending...' : 'Resend verification email'}
          </button>
          {resendMessage ? <p style={{ margin: 0, color: '#86efac' }}>{resendMessage}</p> : null}
          {resendError ? <p style={{ margin: 0, color: '#fca5a5' }}>{resendError}</p> : null}
        </div>
      )}

      {form.lastSubmission?.ok === true ? (
        <div style={{ color: '#86efac' }}>
          <p style={{ marginTop: 0 }}>Your email address has been verified.</p>
          <Link href="/login" style={{ color: '#7dd3fc' }}>Sign in</Link>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        <Link href="/register" style={{ color: '#7dd3fc' }}>Create another account</Link>
        <Link href="/login" style={{ color: '#7dd3fc' }}>Back to sign in</Link>
      </div>
    </section>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<section style={panelStyle}><p style={{ margin: 0 }}>Loading verification form…</p></section>}>
      <VerifyEmailPageContent />
    </Suspense>
  )
}
