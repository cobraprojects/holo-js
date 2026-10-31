'use client'

import { useValidationErrors } from '@holo-js/adapter-next/client'
import { saveName } from '../actions'

export default function Errors() {
  const errors = useValidationErrors()
  return (
    <form action={saveName}>
      <label>Name<input name="name" /></label>
      <p role="alert">{errors.first('name') ?? 'No errors'}</p>
      <button>Save</button>
    </form>
  )
}
