'use client'

import { useRouter } from 'next/navigation'
import { memo, useState } from 'react'
import { useValidationErrors } from '@holo-js/adapter-next/client'
import { saveName } from '../actions'

// Neither rerenders when the router refreshes after the action, so the hook must update them itself.
const NameError = memo(function NameError() {
  const errors = useValidationErrors()
  return <p role="alert">{errors.first('name') ?? 'No errors'}</p>
})

// Mounts only after the form was posted with JavaScript.
const ErrorSummary = memo(function ErrorSummary() {
  const errors = useValidationErrors()
  return <p role="status">{errors.has('name') ? 'Fix the name' : 'Nothing to fix'}</p>
})

export default function Errors() {
  const [posted, setPosted] = useState(false)
  const router = useRouter()
  return (
    <form action={saveName} onSubmit={() => setPosted(true)}>
      <label>Name<input name="name" /></label>
      <NameError />
      {posted ? <ErrorSummary /> : null}
      <button>Save</button>
      <button type="button" onClick={() => router.push('/done')}>Done</button>
    </form>
  )
}
