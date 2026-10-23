<script lang="ts">
  import { useForm } from '@holo-js/adapter-sveltekit/client'
  import type { PageData } from './$types'

  export let data: PageData
  import { contactForm } from '$lib/schemas/framework-forms'

  const contact = useForm(contactForm, { pageData: data, initialValues: { email: 'ava@example.com', password: '' } })
</script>

<h1>Server validation state</h1>
<form method="post">
  <input name="email" aria-label="Contact email" value={contact.values.email} on:input={event => contact.fields.email.onInput(event.currentTarget.value)} />
  <input name="password" type="password" aria-label="Contact password" value={contact.values.password} on:input={event => contact.fields.password.onInput(event.currentTarget.value)} />
  <span data-contact-error>{contact.errors.first('email') ?? ''}</span>
  <button type="submit">Save contact</button>
</form>
