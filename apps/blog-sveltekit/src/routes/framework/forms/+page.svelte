<script lang="ts">
  import { useForm, useValidationErrors } from '@holo-js/adapter-sveltekit/client'
  import { field, schema } from '@holo-js/validation'

  const form = useForm(schema({
    profile: { city: field.string().optional() },
    tags: field.array(field.string()).optional(),
    intent: field.string().optional(),
  }), {
    initialValues: { tags: ['first'] },
    submitter({ values }) {
      if (values.intent === 'deny') throw Object.assign(new Error('Forbidden sample submission.'), { status: 403 })
      return { ok: true, status: 200, data: { city: values.profile?.city, tags: values.tags } }
    },
  })
  const defaultErrors = useValidationErrors()
  const profileErrors = useValidationErrors('profile')
  const contact = useForm(schema({ email: field.string().required().email() }), {
    action: '/api/framework/forms',
    credentials: 'include',
    csrf: { endpoint: '/api/framework/forms' },
    initialValues: { email: 'ava@example.com' },
  })

  async function forbidSubmission() {
    await form.setValue('profile.city', 'Cairo')
    await form.setValue('intent', 'deny')
    await form.submit()
  }
</script>

<section>
  <h1>Form behavior</h1>
  <output data-form-city>{form.values.profile?.city ?? 'missing'}</output>
  <output data-form-tags>{form.values.tags?.join(',')}</output>
  <output data-form-dirty>{form.fields.tags.dirty ? 'dirty' : 'clean'}</output>
  <output data-form-result>{form.lastSubmission?.ok ? JSON.stringify(form.lastSubmission.data) : ''}</output>
  <span data-default-error>{defaultErrors.first('email') ?? ''}</span>
  <span data-profile-error>{profileErrors.first('email') ?? ''}</span>
  <button type="button" on:click={() => form.setValue('profile.city', 'Cairo')}>Load profile</button>
  <button type="button" on:click={() => form.setValue('tags', [...(form.values.tags ?? []), 'second'])}>Add tag</button>
  <button type="button" on:click={() => form.reset({ tags: ['first'] })}>Reset sample</button>
  <button type="button" on:click={forbidSubmission}>Trigger forbidden</button>
  <form on:submit|preventDefault={() => form.submit()}>
    <input type="hidden" name="intent" value={form.values.intent ?? ''} />
    <input type="hidden" name="profile.city" value={form.values.profile?.city ?? ''} />
    {#each form.values.tags ?? [] as tag, index}
      <input type="hidden" name={`tags[${index}]`} value={tag} />
    {/each}
    <button type="submit">Submit sample</button>
  </form>
  <form method="post" action="/api/framework/forms">
    <input name="email" aria-label="HTTP contact email" value={contact.values.email} on:input={event => contact.fields.email.onInput(event.currentTarget.value)} />
    <button type="submit">Submit HTTP contact</button>
    <output data-http-contact-result>{contact.lastSubmission?.ok ? JSON.stringify(contact.lastSubmission.data) : ''}</output>
    <span data-http-contact-error>{contact.errors.first('email') ?? ''}</span>
  </form>
</section>
