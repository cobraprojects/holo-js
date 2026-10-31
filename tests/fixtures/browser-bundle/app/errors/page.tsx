'use client'

import { useValidationErrors } from '@holo-js/adapter-next/client'

export default function Errors() {
  const errors = useValidationErrors()
  return <p role="alert">{errors.first('name') ?? 'No errors'}</p>
}
