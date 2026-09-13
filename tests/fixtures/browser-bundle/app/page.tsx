'use client'

import { useState } from 'react'
import { useForm } from '@holo-js/adapter-next/client'
import { field, schema } from '@holo-js/validation'
import { submitQuote } from './actions'

const quote = schema({ name: field.string().required('Name is required') })

export default function QuoteForm() {
  const [submitted, setSubmitted] = useState('')
  const form = useForm(quote, {
    initialValues: { name: '' },
    async submitter({ values }) {
      if (values.name === 'forbidden') throw { status: 403, message: 'Forbidden' }
      const result = await submitQuote(values.name)
      setSubmitted(result.data.name)
      return result
    },
  })

  return (
    <form onSubmit={(event) => { event.preventDefault(); void form.submit() }}>
      <label>Name<input name="name" value={form.values.name} onChange={event => form.fields.name.onInput(event.currentTarget.value)} /></label>
      <p role="alert">{form.errors.first('name')}</p>
      <button disabled={form.submitting}>Submit</button>
      <output>{submitted}</output>
    </form>
  )
}
