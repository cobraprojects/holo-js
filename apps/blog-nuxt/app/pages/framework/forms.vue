<script setup lang="ts">
import { useForm, useValidationErrors } from '@holo-js/adapter-nuxt/client'
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

async function forbidSubmission() {
  await form.setValue('profile.city', 'Cairo')
  await form.setValue('intent', 'deny')
  await form.submit()
}
</script>

<template>
  <section>
    <h1>Form behavior</h1>
    <output data-form-city>{{ form.values.profile?.city ?? 'missing' }}</output>
    <output data-form-tags>{{ form.values.tags?.join(',') }}</output>
    <output data-form-dirty>{{ form.fields.tags.dirty ? 'dirty' : 'clean' }}</output>
    <output data-form-result>{{ form.lastSubmission?.ok ? JSON.stringify(form.lastSubmission.data) : '' }}</output>
    <span data-default-error>{{ defaultErrors.first('email') ?? '' }}</span>
    <span data-profile-error>{{ profileErrors.first('email') ?? '' }}</span>
    <button type="button" @click="form.setValue('profile.city', 'Cairo')">Load profile</button>
    <button type="button" @click="form.values.tags?.push('second')">Add tag</button>
    <button type="button" @click="form.reset({ tags: ['first'] })">Reset sample</button>
    <button type="button" @click="forbidSubmission">Trigger forbidden</button>
    <form @submit.prevent="form.submit()">
      <input type="hidden" name="intent" :value="form.values.intent ?? ''" />
      <input type="hidden" name="profile.city" :value="form.values.profile?.city ?? ''" />
      <input v-for="(tag, index) in form.values.tags" :key="index" type="hidden" :name="`tags[${index}]`" :value="tag" />
      <button type="submit">Submit sample</button>
    </form>
  </section>
</template>
