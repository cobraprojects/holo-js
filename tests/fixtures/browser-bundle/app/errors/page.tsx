'use client'

import { useValidationErrors } from '@holo-js/adapter-next/client'
import { saveName } from '../actions'

function ErrorSummary() {
  const errors = useValidationErrors()
  return <p role="status">{errors.has('name') ? 'Fix the name' : 'Nothing to fix'}</p>
}

export default function Errors() {
  const errors = useValidationErrors()
  return (
    <form action={saveName}>
      <ErrorSummary />
      <label>Name<input name="name" /></label>
      <p role="alert">{errors.first('name') ?? 'No errors'}</p>
      <button>Save</button>
    </form>
  )
}
